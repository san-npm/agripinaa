'use client';

import { isSessionKeyValid, wasSessionKeyRegistered } from '@agripinaa/session-kit/verify';
import { isDebtCompleteRouter, routerFor } from '@agripinaa/shared/contracts';
import type { AgentSlug, RetiredManagerGrant } from '@agripinaa/shared/agents';
import {
  ALTANA_KEYSTORE_CONTROLLER_BSC,
  managedTokenForFunding,
} from '@agripinaa/shared/funding';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { useCallback, useEffect, useState } from 'react';
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';

import { altanaClient } from '@/lib/altana';
import {
  createBscPublicClient,
  readBscNonceQuorum,
  waitForBscTransactionReceipt,
} from '@/lib/bsc-public-client';
import {
  approveRouter,
  buildManagedScope,
  describeScope,
  fetchManagerKey,
  readManagedPosition,
  readVenueApys,
  registerManaged,
  verifyOnlyStub,
  type VenueApys,
} from '@/lib/managed';
import {
  listStoredRotatedManagerSessions,
  markRegistered,
  storeSession,
} from '@/lib/session-store';
import {
  acquireSessionGrantSubmissionLock,
  acquireSessionGrantBrowserLock,
  clearSessionGrantCheckpoint,
  loadSessionGrantCheckpoint,
  resetRotatedManagerCheckpoint,
  retireExpiredRotatedManagerCheckpoint,
  rotatedManagerCheckpoint,
  reserveSessionGrantCheckpoint,
  restoreRetiredManagerGrantCheckpoint,
  saveRotatedManagerRevocationCheckpoint,
  sameSessionGrantCheckpoint,
  submitSessionGrantCheckpoint,
  type SessionGrantCheckpoint,
} from '@/lib/session-grant-checkpoint';
import {
  findRelaySessionGrant,
  readRelayCallStatus,
  type RelayCallStatus,
} from '@/lib/session-relay-recovery';
import {
  lifetimeOptionForExistingSession,
  recoverExistingSession,
} from '@/lib/session-recovery';
import { compensateSessionStorageFailure } from '@/lib/session-storage-recovery';
import { waitForManagedPrincipal } from '@/lib/managed-principal';
import { toast } from '@/lib/toast';
import {
  FUNDING_ASSETS,
  buildFundingBootstrapPlan,
  fundingGasQuote,
  fundingGasQuoteIsCurrent,
  fundedInputAsset,
  readFundingBalances,
  type FundingAsset,
  type FundingGasQuote,
} from '@/lib/funding-bootstrap';
import {
  assertFundingCheckpointWritable,
  clearFundingCheckpoint,
  recoverFundingCheckpoint,
  saveFundingCheckpoint,
  shouldPauseAfterFundingConfirmation,
  type ConfirmedFundingCheckpoint,
  type FundingCheckpoint,
} from '@/lib/funding-checkpoint';
import { receiptProvesFundingMainBatch } from '@/lib/funding-receipt';
import { recoverableStrategyFundingProblem } from '@/lib/funding-recovery';
import { ActivationProgress, FundingDeposit, RelayGrantNotice } from './FundingDeposit';
import { CoinsIcon, LightningIcon, ShieldIcon, TokenLogo, VerifiedIcon } from './icons';

type Step = 'wallet' | 'deposit' | 'active';

const ACCOUNT_NONCE_ABI = parseAbi([
  'function getNonce(uint192 seqKey) view returns (uint256)',
  'function invalidateNonce(uint256 nonce)',
]);
const KEYSTORE_FEE_ABI = parseAbi([
  'function getRegistrationFeeInWei() view returns (uint256)',
]);
const RESET_NONCE_LANE = 1n;

interface ManagedAgentProps {
  chainId: number;
  tokenId: string;
  name: string;
  /** Runner agent name for the manage/manager-key endpoints (e.g. "yield"). */
  managedAgent: AgentSlug;
  /** Policy-specific language; Harvester and Steward are not one generic choice. */
  submitLabel?: string;
  activeSummary?: string;
}

type PasskeyWallet = Awaited<
  ReturnType<ReturnType<typeof altanaClient>['createPasskeyWallet']>
>;
type ManagedSession = Awaited<ReturnType<ReturnType<typeof altanaClient>['grantSession']>>;

interface GrantedManagedActivation {
  session: ManagedSession;
  local: ReturnType<typeof storeSession>;
}

interface RecoveredManagedFunding {
  expectedTotalWei: bigint;
  formattedPrincipal: string;
}

interface RotatedGrantReset {
  checkpoint: SessionGrantCheckpoint;
  currentPublicKey: Hex;
  requiresRevocation: boolean;
  cancellation?: boolean;
}

export function ManagedWizard({ agent }: { agent: ManagedAgentProps }) {
  const [step, setStep] = useState<Step>('wallet');
  const chainId = 56;
  const [fundingAsset, setFundingAsset] = useState<FundingAsset>('USDT');
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [pendingWallet, setPendingWallet] = useState(false);
  const [recoveredFunding, setRecoveredFunding] = useState<RecoveredManagedFunding | null>(null);
  const [nativeBal, setNativeBal] = useState<bigint | null>(null);
  const [balances, setBalances] = useState<Record<FundingAsset, bigint | null>>({
    BTCB: null,
    BNB: null,
    USDT: null,
    USDC: null,
  });
  const [gasQuote, setGasQuote] = useState<FundingGasQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [preparedFunding, setPreparedFunding] = useState<FundingCheckpoint | null>(null);
  const [grantedActivation, setGrantedActivation] = useState<GrantedManagedActivation | null>(null);
  const [relayGrantStatus, setRelayGrantStatus] = useState<RelayCallStatus | null>(null);
  const [relayRevocationStatus, setRelayRevocationStatus] = useState<RelayCallStatus | null>(null);
  const [rotatedGrantReset, setRotatedGrantReset] = useState<RotatedGrantReset | null>(null);
  const [recoveredExpiry, setRecoveredExpiry] = useState<number | null>(null);
  const [hours, setHours] = useState<number>(168);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [apys, setApys] = useState<VenueApys | null>(null);
  const token = managedTokenForFunding(agent.managedAgent, fundingAsset);

  useEffect(() => {
    let cancelled = false;
    readVenueApys(chainId, token)
      .then((a) => !cancelled && setApys(a))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chainId, token]);

  const bestApyPct = apys ? Math.max(apys.venusApyBps, apys.aaveApyBps) / 100 : null;
  const bestVenue = apys ? (apys.venusApyBps >= apys.aaveApyBps ? 'Venus' : 'Aave') : null;

  const deployment = routerFor(chainId, token);
  const automationReady = isDebtCompleteRouter(deployment);
  const publicClient = useCallback(
    () => createBscPublicClient(),
    [],
  );

  async function verifyRecoverableManagedAccount(w: PasskeyWallet): Promise<RecoveredManagedFunding> {
    setPhase('Checking the funded account on BNB Chain…');
    const account = w.address as Hex;
    const router = routerFor(chainId, token)!;
    const chainClient = publicClient();
    const position = await readManagedPosition(account, chainId, token, router.address, chainClient as never);
    const expectedTotalWei = position.idleWei + position.deployedWei;
    if (expectedTotalWei <= 0n) {
      throw new Error(`No recoverable ${agent.name} funding was found in this account.`);
    }
    const manager = await fetchManagerKey(agent.managedAgent, token);
    const recoveredSession = await recoverExistingSession({
      account,
      manager,
      scope: buildManagedScope({ chainId, hours, token }),
      signatureCheckers: [],
      signer: verifyOnlyStub(manager.address, manager.publicKey),
      maximumExpiry: null,
    });
    const [nativeBalance, registrationFee, allowances] = await Promise.all([
      chainClient.getBalance({ address: account }),
      chainClient.readContract({
        address: ALTANA_KEYSTORE_CONTROLLER_BSC,
        abi: KEYSTORE_FEE_ABI,
        functionName: 'getRegistrationFeeInWei',
      }),
      Promise.all([router.usdt, router.aUsdt, router.vUsdt].map((asset) => chainClient.readContract({
        address: asset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, router.address],
      }))),
    ]);
    const problem = recoverableStrategyFundingProblem({
      agentName: agent.name,
      requiredAssets: [token],
      inventory: { [token]: expectedTotalWei },
      allowances,
      nativeBalance,
      registrationFee,
      hasLiveSession: recoveredSession !== null,
    });
    if (problem) throw new Error(problem);
    if (recoveredSession) setHours(lifetimeOptionForExistingSession(recoveredSession.session.expiry));
    return { expectedTotalWei, formattedPrincipal: position.totalUsdt };
  }

  async function connectPasskey(mode: 'create' | 'recover') {
    if (!automationReady) {
      setError('Managed activation is paused while the debt-complete router is deployed.');
      return;
    }
    setBusy(true);
    setError(null);
    setRelayGrantStatus(null);
    setRelayRevocationStatus(null);
    setRotatedGrantReset(null);
    try {
      const client = altanaClient();
      const w =
        mode === 'create'
          ? await client.createPasskeyWallet({ name: 'Agripinaa' })
          : await client.recoverFromPasskey();
      const pending = mode === 'recover' && 'pending' in w && w.pending === true;
      setPendingWallet(pending);
      const checkpoint = await recoverFundingCheckpoint(chainId, w.address as `0x${string}`, agent.managedAgent);
      if (checkpoint?.expectedTotalWei !== undefined) {
        setFundingAsset(checkpoint.plan.input);
        setPreparedFunding(checkpoint);
        setRecoveredFunding(null);
      } else if (mode === 'recover' && !pending) {
        setPreparedFunding(null);
        try {
          setRecoveredFunding(await verifyRecoverableManagedAccount(w));
        } catch (cause) {
          const missingPreparedFunding = cause instanceof Error
            && cause.message === `No recoverable ${agent.name} funding was found in this account.`;
          if (!missingPreparedFunding) throw cause;
          const nextBalances = await readFundingBalances(w.address as Hex);
          const fundedAsset = fundedInputAsset(nextBalances);
          if (!fundedAsset) throw cause;
          setPendingWallet(true);
          setFundingAsset(fundedAsset);
          setNativeBal(nextBalances.BNB);
          setBalances(nextBalances);
          setRecoveredFunding(null);
        }
      } else {
        setPreparedFunding(null);
        setRecoveredFunding(null);
      }
      setWallet(w);
      setStep('deposit');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPhase('');
    }
  }

  useEffect(() => {
    if (step !== 'deposit' || !wallet) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const nextBalances = await readFundingBalances(wallet.address as Hex);
        if (!cancelled) {
          setNativeBal(nextBalances.BNB);
          setBalances(nextBalances);
          if (pendingWallet && !preparedFunding) {
            setFundingAsset((current) => nextBalances[current] > 0n
              ? current
              : FUNDING_ASSETS.find((asset) => nextBalances[asset] > 0n) ?? current);
          }
        }
      } catch {
        /* transient RPC failure; next tick retries */
      }
    };
    void tick();
    const t = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pendingWallet, preparedFunding, step, wallet, publicClient]);

  useEffect(() => {
    if (step !== 'deposit') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await fundingGasQuote(fundingAsset);
        if (!cancelled) {
          setGasQuote(next);
          setQuoteError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setGasQuote(null);
          setQuoteError(cause instanceof Error ? cause.message : 'Gas quote unavailable.');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fundingAsset, step]);

  async function activate(resetRequest?: RotatedGrantReset) {
    if (!wallet) return;
    if (!automationReady) {
      setError('Managed activation is paused while the debt-complete router is deployed.');
      return;
    }
    setBusy(true);
    setError(null);
    const pauseAfterFunding = shouldPauseAfterFundingConfirmation(
      preparedFunding,
      recoveredFunding !== null,
    );
    try {
      const fundingClient = publicClient();
      const router = routerFor(chainId, token)!;
      let prepared = preparedFunding;
      if (prepared?.status === 'submitted') {
        setPhase('Resuming the already-submitted funding transaction…');
        const resumed = await readRelayCallStatus({
          callsId: prepared.callsId,
        });
        if (resumed.status === 'pending') {
          throw new Error('The funding transaction is still pending. It is saved safely; retry activation without depositing again.');
        }
        if (resumed.status === 'failed' || !resumed.transactionHash) {
          clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
          setPreparedFunding(null);
          throw new Error('The saved funding transaction failed. No strategy funding was recorded; review the quote and retry.');
        }
        const receipt = await waitForBscTransactionReceipt(resumed.transactionHash);
        if (
          receipt.status !== 'success'
          || !receiptProvesFundingMainBatch(
            receipt.logs as never,
            wallet.address as `0x${string}`,
            prepared.plan.nativeReserveOutputWei,
          )
        ) {
          clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
          setPreparedFunding(null);
          throw new Error('The saved relay transaction did not complete the account funding calls. Review the balance and retry; no successful funding checkpoint was retained.');
        }
        const confirmed: ConfirmedFundingCheckpoint = {
          ...prepared,
          status: 'confirmed',
          transactionHash: resumed.transactionHash,
          receiptBlockNumber: receipt.blockNumber,
        };
        saveFundingCheckpoint(
          chainId,
          wallet.address as `0x${string}`,
          agent.managedAgent,
          confirmed,
        );
        setPreparedFunding(confirmed);
        prepared = confirmed;
      }
      if (!prepared && !recoveredFunding) {
        // 1. Snapshot the old target position, then prepare the single deposit
        // and approve the router in one owner bundle.
        setPhase('Building the deposit preparation…');
        const baseline = await readManagedPosition(
          wallet.address as `0x${string}`,
          chainId,
          token,
          router.address,
          fundingClient as never,
        );
        const displayedQuote = fundingGasQuoteIsCurrent(gasQuote, fundingAsset, 5_000)
          ? gasQuote
          : null;
        if (!displayedQuote) {
          const refreshed = await fundingGasQuote(fundingAsset);
          setGasQuote(refreshed);
          setQuoteError(null);
          throw new Error('The gas allocation quote was refreshed. Review the updated deduction, then confirm activation again.');
        }
        const plan = await buildFundingBootstrapPlan({
          account: wallet.address as `0x${string}`,
          agent: agent.managedAgent,
          input: fundingAsset,
          grossInput: balances[fundingAsset] ?? 0n,
          nativeBalance: nativeBal ?? 0n,
          gasQuote: displayedQuote,
          quoteClient: fundingClient as never,
          merchantUrl: new URL('/api/funding/merchant', window.location.origin).toString(),
        });
        setPhase('Preparing your deposit (1 passkey confirmation, 1 funding transaction)…');
        const minimumOutput = plan.minimumOutputs[token] ?? 0n;
        if (minimumOutput <= 0n) throw new Error('Funding produced no managed principal.');
        const baselineTotal = baseline.idleWei + baseline.deployedWei;
        const allocation = plan.gasReserveInput + plan.bootstrapFeeInput;
        const expectedTotalWei = fundingAsset === token
          ? baselineTotal - allocation
          : baselineTotal + minimumOutput;
        if (expectedTotalWei <= 0n) throw new Error('Funding produced no managed principal.');
        try {
          assertFundingCheckpointWritable(
            chainId,
            wallet.address as `0x${string}`,
            agent.managedAgent,
            plan,
            expectedTotalWei,
          );
        } catch {
          throw new Error('This browser cannot save a funding recovery checkpoint. Enable site storage before confirming the transaction.');
        }
        const fundingResult = await approveRouter(wallet, chainId, token, {
          ...plan,
          onSubmitted: (callsId) => {
            const submitted: FundingCheckpoint = {
              status: 'submitted',
              callsId,
              plan,
              expectedTotalWei,
            };
            // Retain the id in this tab even if browser persistence becomes
            // unavailable after the full-size reservation succeeded.
            setPreparedFunding(submitted);
            saveFundingCheckpoint(
              chainId,
              wallet.address as `0x${string}`,
              agent.managedAgent,
              submitted,
            );
          },
        });
        if (!fundingResult.transactionHash) {
          throw new Error('The confirmed funding bundle returned no transaction hash.');
        }
        const receipt = await waitForBscTransactionReceipt(fundingResult.transactionHash);
        if (
          receipt.status !== 'success'
          || !receiptProvesFundingMainBatch(
            receipt.logs as never,
            wallet.address as `0x${string}`,
            plan.nativeReserveOutputWei,
          )
        ) {
          clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
          setPreparedFunding(null);
          throw new Error(
            'The relay transaction did not complete the account funding calls. Review the balance and retry; no successful funding checkpoint was retained.',
          );
        }
        const confirmed: ConfirmedFundingCheckpoint = {
          status: 'confirmed',
          callsId: fundingResult.callsId,
          plan,
          transactionHash: fundingResult.transactionHash,
          expectedTotalWei,
          receiptBlockNumber: receipt.blockNumber,
        };
        // Only a receipt carrying the account's exact reserve-withdrawal event
        // proves the merchant-paid main batch succeeded. The outer receipt by
        // itself can be successful after a caught inner revert.
        try {
          saveFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent, confirmed);
        } catch {
          throw new Error('Funding confirmed, but this browser could not save the retry checkpoint. Keep this page open and retry activation here; do not fund again.');
        }
        setPreparedFunding(confirmed);
        prepared = confirmed;
      }

      if (!recoveredFunding && prepared?.status !== 'confirmed') {
        throw new Error('The saved funding transaction has not confirmed yet. Retry activation without depositing again.');
      }
      if (pauseAfterFunding) {
        toast({
          title: 'Funding confirmed',
          detail: `Continue below to grant ${agent.name} its scoped mandate.`,
          kind: 'success',
        });
        return;
      }
      const expectedTotalWei = recoveredFunding?.expectedTotalWei ?? prepared?.expectedTotalWei;
      if (expectedTotalWei === undefined) {
        clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
        setPreparedFunding(null);
        throw new Error('The saved managed-funding checkpoint is incomplete. Review the account balance before retrying.');
      }

      const client = altanaClient();
      setPhase('Checking for an existing managed session…');
      const manager = await fetchManagerKey(agent.managedAgent, token);
      const account = wallet.address as `0x${string}`;
      const retiredNonceIsInvalid = async (grant: RetiredManagerGrant): Promise<boolean> => {
        const nonce = BigInt(grant.nonce);
        const current = await readBscNonceQuorum(account, nonce >> 64n);
        return current > nonce;
      };
      const pinnedRetiredGrant = manager.retired.find((grant) =>
        grant.account.toLowerCase() === account.toLowerCase()
        && grant.expiry > Math.floor(Date.now() / 1_000));
      if (pinnedRetiredGrant && !loadSessionGrantCheckpoint(chainId, account, agent.managedAgent)) {
        const retiredStillLive = await isSessionKeyValid({
          chainId,
          account,
          sessionPublicKey: pinnedRetiredGrant.publicKey,
        });
        if (!await retiredNonceIsInvalid(pinnedRetiredGrant) || retiredStillLive) {
          await restoreRetiredManagerGrantCheckpoint(
            chainId,
            account,
            agent.managedAgent,
            pinnedRetiredGrant,
          );
        }
      }
      let granted = grantedActivation;
      if (
        granted
        && granted.local.publicKey?.toLowerCase() !== manager.publicKey.toLowerCase()
      ) {
        // The runner rotated while this tab retained a grant whose handoff had
        // failed. Re-enter recovery instead of retrying that stale key forever.
        granted = null;
        setGrantedActivation(null);
      }
      if (!granted) {
        // 2. Fetch the pinned manager key, recovering an exact on-chain grant
        // first if a relay confirmation was lost before browser persistence.
        const inspectPreviousGrant = async (checkpoint: SessionGrantCheckpoint) => {
          const previousStillLive = await isSessionKeyValid({
            chainId,
            account,
            sessionPublicKey: checkpoint.publicKey,
          });
          const priorOutcome = checkpoint.status === 'submitted'
            ? await readRelayCallStatus({ callsId: checkpoint.callsId })
            : await findRelaySessionGrant({ account, publicKey: checkpoint.publicKey });
          const previousWasRegistered = previousStillLive
            || (priorOutcome?.status === 'confirmed' && await wasSessionKeyRegistered({
              chainId,
              account,
              sessionPublicKey: checkpoint.publicKey,
            }));
          return { previousStillLive, previousWasRegistered, priorOutcome };
        };

        const retiredGrantFor = (checkpoint: SessionGrantCheckpoint): RetiredManagerGrant | undefined =>
          manager.retired.find((grant) =>
            grant.account.toLowerCase() === account.toLowerCase()
            && grant.publicKey.toLowerCase() === checkpoint.publicKey.toLowerCase()
            && grant.expiry === checkpoint.expiry);

        const cancelPendingRetiredGrant = async (
          checkpoint: SessionGrantCheckpoint,
          grant: RetiredManagerGrant,
        ): Promise<SessionGrantCheckpoint> => {
          setPhase('Canceling the stalled mandate (1 passkey tap)…');
          let releaseTransitionLock: (() => Promise<void>) | null = await acquireSessionGrantBrowserLock(
            chainId,
            account,
            agent.managedAgent,
          );
          let canceling: SessionGrantCheckpoint | null = null;
          try {
            const current = loadSessionGrantCheckpoint(chainId, account, agent.managedAgent);
            if (!sameSessionGrantCheckpoint(current, checkpoint)) {
              throw new Error('Another tab already changed the stalled mandate checkpoint. No duplicate cancellation was submitted.');
            }
            const resetNonce = await fundingClient.readContract({
              address: account,
              abi: ACCOUNT_NONCE_ABI,
              functionName: 'getNonce',
              args: [RESET_NONCE_LANE],
            });
            await client.execute({
              wallet,
              signer: wallet.signer,
              chainId,
              nonce: resetNonce,
              noWait: true,
              calls: {
                to: account,
                data: encodeFunctionData({
                  abi: ACCOUNT_NONCE_ABI,
                  functionName: 'invalidateNonce',
                  args: [BigInt(grant.nonce)],
                }),
              },
              onSubmitted: async (callsId) => {
                canceling = saveRotatedManagerRevocationCheckpoint(
                  chainId,
                  account,
                  agent.managedAgent,
                  checkpoint,
                  manager.publicKey,
                  callsId,
                );
                setRotatedGrantReset({
                  checkpoint: canceling,
                  currentPublicKey: manager.publicKey,
                  requiresRevocation: true,
                  cancellation: true,
                });
                setRelayGrantStatus(null);
                setRelayRevocationStatus({ callsId, status: 'pending' });
                await releaseTransitionLock?.();
                releaseTransitionLock = null;
              },
            });
          } finally {
            await (releaseTransitionLock as (() => Promise<void>) | null)?.();
          }
          if (!canceling) {
            throw new Error('The stalled mandate cancellation returned without a saved relay reference. No replacement was submitted.');
          }
          return canceling;
        };

        const revokePreviousGrant = async (
          checkpoint: SessionGrantCheckpoint,
        ): Promise<SessionGrantCheckpoint | null> => {
          setPhase('Revoking the previous manager mandate (1 passkey tap)…');
          let releaseTransitionLock: (() => Promise<void>) | null = await acquireSessionGrantBrowserLock(
            chainId,
            account,
            agent.managedAgent,
          );
          let revoking: SessionGrantCheckpoint | null = null;
          let revoked: Awaited<ReturnType<typeof client.revokeSession>>;
          try {
            const current = loadSessionGrantCheckpoint(
              chainId,
              account,
              agent.managedAgent,
            );
            if (!sameSessionGrantCheckpoint(current, checkpoint)) {
              throw new Error('Another tab already changed the old mandate checkpoint. No duplicate revocation was submitted.');
            }
            revoked = await client.revokeSession({
              wallet,
              signer: wallet.signer,
              chainId,
              session: checkpoint.publicKey,
              onSubmitted: async (callsId) => {
                revoking = saveRotatedManagerRevocationCheckpoint(
                  chainId,
                  account,
                  agent.managedAgent,
                  checkpoint,
                  manager.publicKey,
                  callsId,
                );
                setRotatedGrantReset({
                  checkpoint: revoking,
                  currentPublicKey: manager.publicKey,
                  requiresRevocation: true,
                });
                setRelayGrantStatus(null);
                setRelayRevocationStatus({ callsId, status: 'pending' });
                await releaseTransitionLock?.();
                releaseTransitionLock = null;
              },
            });
          } finally {
            await (releaseTransitionLock as (() => Promise<void>) | null)?.();
          }
          if (revoking === null) {
            throw new Error('The previous mandate revocation returned without a saved relay reference. No replacement was submitted.');
          }
          const outcome: RelayCallStatus = {
            callsId: revoked.callsId,
            status: revoked.status === 'CONFIRMED'
              ? 'confirmed'
              : revoked.status === 'FAILED'
                ? 'failed'
                : 'pending',
            ...(revoked.transactionHash ? { transactionHash: revoked.transactionHash } : {}),
          };
          setRelayRevocationStatus(outcome);
          if (outcome.status !== 'confirmed') return revoking;
          if (await isSessionKeyValid({
            chainId,
            account,
            sessionPublicKey: checkpoint.publicKey,
          })) {
            throw new Error('The relay confirmed the old mandate revocation, but BNB Chain still reports that key as active. Retry shortly; no replacement was submitted.');
          }
          await resetRotatedManagerCheckpoint(
            chainId,
            account,
            agent.managedAgent,
            revoking,
            manager.publicKey,
          );
          return null;
        };

        if (resetRequest) {
          if (manager.publicKey.toLowerCase() !== resetRequest.currentPublicKey.toLowerCase()) {
            throw new Error(`${agent.name}'s manager key changed again before reset. Nothing was submitted; reload and review the new key.`);
          }
          const resetRetiredGrant = retiredGrantFor(resetRequest.checkpoint);
          const resetPreviousStillLive = resetRetiredGrant && await isSessionKeyValid({
            chainId,
            account,
            sessionPublicKey: resetRequest.checkpoint.publicKey,
          });
          if (
            resetRetiredGrant
            && await retiredNonceIsInvalid(resetRetiredGrant)
            && !resetPreviousStillLive
          ) {
            await resetRotatedManagerCheckpoint(
              chainId,
              account,
              agent.managedAgent,
              resetRequest.checkpoint,
              manager.publicKey,
            );
          } else if (resetRequest.checkpoint.status === 'revoking') {
            const revocation = await readRelayCallStatus({ callsId: resetRequest.checkpoint.callsId });
            setRelayRevocationStatus(revocation);
            const retiredGrant = resetRetiredGrant;
            const previousStillLive = await isSessionKeyValid({
              chainId,
              account,
              sessionPublicKey: resetRequest.checkpoint.publicKey,
            });
            if (revocation.status === 'pending') return;
            if (revocation.status === 'confirmed') {
              if (retiredGrant ? !await retiredNonceIsInvalid(retiredGrant) || previousStillLive : previousStillLive) {
                throw new Error(retiredGrant
                  ? 'The relay confirmed the cancellation, but BNB Chain has not advanced the stalled nonce yet. Retry shortly; no replacement was submitted.'
                  : 'The relay confirmed the old mandate revocation, but BNB Chain still reports that key as active. Retry shortly; no replacement was submitted.');
              }
              await resetRotatedManagerCheckpoint(
                chainId,
                account,
                agent.managedAgent,
                resetRequest.checkpoint,
                manager.publicKey,
              );
            } else {
              const oldGrant = await findRelaySessionGrant({
                account,
                publicKey: resetRequest.checkpoint.publicKey,
              });
              if (previousStillLive) {
                const pending = await revokePreviousGrant(resetRequest.checkpoint);
                if (pending) return;
              } else if (oldGrant && retiredGrant) {
                await cancelPendingRetiredGrant(resetRequest.checkpoint, retiredGrant);
                return;
              } else if (oldGrant) {
                throw new Error(`The previous pending mandate cannot be canceled automatically. No replacement will be submitted before ${new Date(resetRequest.checkpoint.expiry * 1_000).toISOString()}.`);
              } else {
                await resetRotatedManagerCheckpoint(
                  chainId,
                  account,
                  agent.managedAgent,
                  resetRequest.checkpoint,
                  manager.publicKey,
                );
              }
            }
          } else {
            const previous = await inspectPreviousGrant(resetRequest.checkpoint);
            if (previous.priorOutcome) setRelayGrantStatus(previous.priorOutcome);
            if (previous.priorOutcome?.status === 'confirmed' && !previous.previousWasRegistered) {
              throw new Error('The relay confirmed the previous mandate, but BNB Chain has not indexed it yet. Retry shortly; no replacement was submitted.');
            }
            if (previous.previousStillLive) {
              const pending = await revokePreviousGrant(resetRequest.checkpoint);
              if (pending) return;
            } else if (previous.priorOutcome?.status === 'pending') {
              const retiredGrant = retiredGrantFor(resetRequest.checkpoint);
              if (!retiredGrant) {
                throw new Error(`The previous pending mandate cannot be canceled automatically. No replacement will be submitted before ${new Date(resetRequest.checkpoint.expiry * 1_000).toISOString()}.`);
              }
              await cancelPendingRetiredGrant(resetRequest.checkpoint, retiredGrant);
              return;
            } else {
              await resetRotatedManagerCheckpoint(
                chainId,
                account,
                agent.managedAgent,
                resetRequest.checkpoint,
                manager.publicKey,
              );
            }
          }
          setRelayRevocationStatus(null);
          if (rotatedManagerCheckpoint(chainId, account, agent.managedAgent, manager.publicKey)) {
            throw new Error('The previous manager checkpoint remains present. No replacement was submitted.');
          }
          setRotatedGrantReset(null);
          setRelayGrantStatus(null);
        }
        let scope = buildManagedScope({ chainId, hours, token });
        const sessionSigner = verifyOnlyStub(manager.address, manager.publicKey);
        let rotatedCheckpoint = rotatedManagerCheckpoint(
          chainId,
          account,
          agent.managedAgent,
          manager.publicKey,
        );
        if (!rotatedCheckpoint) {
          // A confirmed grant checkpoint is cleared after the browser saves the
          // revocation record, before runner handoff. Recover that record too:
          // a failed handoff must not make a still-live old key invisible.
          const savedOldSessions = listStoredRotatedManagerSessions({
            chainId,
            account,
            agent: agent.managedAgent,
            agentTokenId: agent.tokenId,
            target: router.address,
            currentPublicKey: manager.publicKey,
          });
          for (const saved of savedOldSessions) {
            if (!await isSessionKeyValid({
              chainId,
              account,
              sessionPublicKey: saved.publicKey,
            })) continue;
            reserveSessionGrantCheckpoint(
              chainId,
              account,
              agent.managedAgent,
              saved.publicKey,
              saved.expiry,
            );
            rotatedCheckpoint = rotatedManagerCheckpoint(
              chainId,
              account,
              agent.managedAgent,
              manager.publicKey,
            );
            break;
          }
        }
        const activationPosition = await waitForManagedPrincipal(
          () => readManagedPosition(
            wallet.address as `0x${string}`,
            chainId,
            token,
            router.address,
            fundingClient as never,
            prepared?.status === 'confirmed' ? prepared.receiptBlockNumber : undefined,
          ),
          expectedTotalWei,
        );
        if (rotatedCheckpoint && rotatedCheckpoint.expiry > Math.floor(Date.now() / 1_000)) {
          const retiredGrant = retiredGrantFor(rotatedCheckpoint);
          const retiredStillLive = retiredGrant && await isSessionKeyValid({
            chainId,
            account,
            sessionPublicKey: rotatedCheckpoint.publicKey,
          });
          if (retiredGrant && await retiredNonceIsInvalid(retiredGrant) && !retiredStillLive) {
            await resetRotatedManagerCheckpoint(
              chainId,
              account,
              agent.managedAgent,
              rotatedCheckpoint,
              manager.publicKey,
            );
          } else if (rotatedCheckpoint.status === 'revoking') {
            const revocation = await readRelayCallStatus({ callsId: rotatedCheckpoint.callsId });
            setRelayRevocationStatus(revocation);
            const previousStillLive = await isSessionKeyValid({
              chainId,
              account,
              sessionPublicKey: rotatedCheckpoint.publicKey,
            });
            const transitionConfirmed = revocation.status === 'confirmed'
              && (retiredGrant ? await retiredNonceIsInvalid(retiredGrant) && !previousStillLive : !previousStillLive);
            if (transitionConfirmed) {
              await resetRotatedManagerCheckpoint(
                chainId,
                account,
                agent.managedAgent,
                rotatedCheckpoint,
                manager.publicKey,
              );
            } else {
              setRotatedGrantReset({
                checkpoint: rotatedCheckpoint,
                currentPublicKey: manager.publicKey,
                requiresRevocation: true,
                ...(retiredGrant && !previousStillLive ? { cancellation: true } : {}),
              });
              return;
            }
          } else {
            const previous = await inspectPreviousGrant(rotatedCheckpoint);
            if (previous.priorOutcome) setRelayGrantStatus(previous.priorOutcome);
            if (previous.priorOutcome?.status === 'confirmed' && !previous.previousWasRegistered) {
              throw new Error('The relay confirmed the previous mandate, but BNB Chain has not indexed it yet. Retry shortly; no replacement was submitted.');
            }
            if (
              previous.previousStillLive
              || previous.priorOutcome?.status === 'pending'
              || rotatedCheckpoint.status === 'reserved'
            ) {
              const cancellation = !previous.previousStillLive
                && previous.priorOutcome?.status === 'pending'
                && retiredGrantFor(rotatedCheckpoint) !== undefined;
              setRotatedGrantReset({
                checkpoint: rotatedCheckpoint,
                currentPublicKey: manager.publicKey,
                requiresRevocation: previous.previousStillLive || previous.priorOutcome?.status === 'pending',
                ...(cancellation ? { cancellation: true } : {}),
              });
              return;
            }
            await resetRotatedManagerCheckpoint(
              chainId,
              account,
              agent.managedAgent,
              rotatedCheckpoint,
              manager.publicKey,
            );
          }
          setRelayGrantStatus(null);
          setRelayRevocationStatus(null);
        }
        let grantCheckpoint = await retireExpiredRotatedManagerCheckpoint(
          chainId,
          wallet.address as `0x${string}`,
          agent.managedAgent,
          manager.publicKey,
        );
        if (grantCheckpoint) scope = { ...scope, expiry: grantCheckpoint.expiry };
        const relayGrant = grantCheckpoint?.status === 'submitted'
          ? null
          : await findRelaySessionGrant({
            account: wallet.address as `0x${string}`,
            publicKey: manager.publicKey,
          });
        if (grantCheckpoint?.status === 'reserved' && relayGrant) {
          submitSessionGrantCheckpoint(
            chainId,
            wallet.address as `0x${string}`,
            agent.managedAgent,
            manager.publicKey,
            grantCheckpoint.expiry,
            relayGrant.callsId,
          );
          grantCheckpoint = loadSessionGrantCheckpoint(
            chainId,
            wallet.address as `0x${string}`,
            agent.managedAgent,
          );
        }
        let recovered = await recoverExistingSession({
          account: wallet.address as `0x${string}`,
          manager,
          scope,
          signatureCheckers: [],
          signer: sessionSigner,
        });
        if (!recovered && relayGrant?.status === 'pending') {
          setRelayGrantStatus(relayGrant);
          toast({
            title: 'Agent mandate is waiting at the relay',
            detail: 'Funding is confirmed and no duplicate grant was submitted.',
          });
          return;
        }
        if (!recovered && grantCheckpoint) {
          if (grantCheckpoint.status === 'reserved') {
            throw new Error(`A previous signed session grant has no definitive relay outcome yet. Activation will not submit this manager key twice; retry later. If it remains unresolved, rotate the manager key and retry after ${new Date(grantCheckpoint.expiry * 1_000).toISOString()}.`);
          }
          setPhase('Reconciling the previous session grant with the relay…');
          const outcome = await readRelayCallStatus({
            callsId: grantCheckpoint.callsId,
          });
          if (outcome.status === 'pending') {
            setRelayGrantStatus(outcome);
            return;
          }
          if (outcome.status === 'failed') {
            clearSessionGrantCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
            if (relayGrantStatus?.status !== 'failed') {
              setRelayGrantStatus(outcome);
              return;
            }
            setRelayGrantStatus(null);
            grantCheckpoint = null;
            scope = buildManagedScope({ chainId, hours, token });
            recovered = await recoverExistingSession({
              account: wallet.address as `0x${string}`,
              manager,
              scope,
              signatureCheckers: [],
              signer: sessionSigner,
            });
          } else {
            setRelayGrantStatus(outcome);
            setPhase('Recovering the relay-confirmed session on BNB Chain…');
            recovered = await recoverExistingSession({
              account: wallet.address as `0x${string}`,
              manager,
              scope,
              signatureCheckers: [],
              signer: sessionSigner,
            });
            if (!recovered) {
              return;
            }
          }
        }
        if (!recovered && !grantCheckpoint && relayGrant?.status === 'confirmed') {
          setRelayGrantStatus(relayGrant);
          setPhase('Recovering the relay-confirmed session on BNB Chain…');
          recovered = await recoverExistingSession({
            account: wallet.address as `0x${string}`,
            manager,
            scope,
            signatureCheckers: [],
            signer: sessionSigner,
          });
          if (!recovered) {
            return;
          }
        }
        const recoveredExisting = recovered !== null;
        let session: ManagedSession;
        if (recovered) {
          setRelayGrantStatus(null);
          setPhase('Recovering the confirmed managed session…');
          session = recovered.session as ManagedSession;
          setRecoveredExpiry(recovered.session.expiry);
        } else {
          setRelayGrantStatus(null);
          setPhase('Granting the managed session (1 passkey tap)…');
          let releaseGrantLock: (() => Promise<void>) | null = null;
          try {
            try {
              session = await client.grantSession({
                wallet,
                signer: wallet.signer,
                chainId,
                sessionSigner: sessionSigner as never,
                onBeforeSubmit: async () => {
                  releaseGrantLock = await acquireSessionGrantSubmissionLock(
                    chainId,
                    wallet.address as `0x${string}`,
                    agent.managedAgent,
                    manager.publicKey,
                    scope.expiry,
                  );
                  const concurrentGrant = await findRelaySessionGrant({
                    account: wallet.address as `0x${string}`,
                    publicKey: manager.publicKey,
                  });
                  if (concurrentGrant) {
                    throw new Error('This manager grant was submitted by another tab or device. Activation stopped before sending a duplicate; retry to recover it.');
                  }
                  reserveSessionGrantCheckpoint(
                    chainId,
                    wallet.address as `0x${string}`,
                    agent.managedAgent,
                    manager.publicKey,
                    scope.expiry,
                  );
                },
                onSubmitted: async (callsId) => {
                  submitSessionGrantCheckpoint(
                    chainId,
                    wallet.address as `0x${string}`,
                    agent.managedAgent,
                    manager.publicKey,
                    scope.expiry,
                    callsId,
                  );
                  setRelayGrantStatus({ callsId, status: 'pending' });
                  await releaseGrantLock?.();
                  releaseGrantLock = null;
                },
                ...scope,
              });
              const submitted = loadSessionGrantCheckpoint(
                chainId,
                wallet.address as `0x${string}`,
                agent.managedAgent,
              );
              if (submitted?.status !== 'submitted') {
                throw new Error('The confirmed agent mandate has no saved relay reference. Activation stopped before handoff.');
              }
              const outcome = await readRelayCallStatus({ callsId: submitted.callsId })
                .catch((): RelayCallStatus => ({ callsId: submitted.callsId, status: 'pending' }));
              if (outcome.status !== 'confirmed') {
                if (outcome.status === 'failed') {
                  clearSessionGrantCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
                }
                setRelayGrantStatus(outcome);
                return;
              }
              setRelayGrantStatus(null);
            } catch (grantError) {
              const submitted = loadSessionGrantCheckpoint(
                chainId,
                wallet.address as `0x${string}`,
                agent.managedAgent,
              );
              if (submitted?.status !== 'submitted') throw grantError;
              const outcome = await readRelayCallStatus({ callsId: submitted.callsId })
                .catch((): RelayCallStatus => ({ callsId: submitted.callsId, status: 'pending' }));
              if (outcome.status === 'failed') {
                clearSessionGrantCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
              }
              setRelayGrantStatus(outcome);
              return;
            }
          } finally {
            await (releaseGrantLock as (() => Promise<void>) | null)?.();
          }
        }
        const summary = describeScope({ ...scope, expiry: session.expiry });
        // Persist the revoke/recovery bundle BEFORE the network handoff. If the
        // POST fails or its response is lost, the live key remains visible and
        // revocable from the dashboard instead of becoming orphaned authority.
        let local: ReturnType<typeof storeSession>;
        try {
          local = storeSession({
            session,
            chainId,
            agent: { chainId: agent.chainId, tokenId: agent.tokenId, name: agent.name, slug: agent.managedAgent },
            scope: { allowlist: [router.address], capFormatted: summary.capFormatted, expiresAt: summary.expiresAt },
            principalUsdt: activationPosition.totalUsdt,
          });
          clearSessionGrantCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
        } catch (storageError) {
          if (recoveredExisting) {
            throw new Error(
              `The existing on-chain session is valid, but this browser could not save its recovery record. No duplicate grant was submitted. ${storageError instanceof Error ? storageError.message : ''}`.trim(),
            );
          }
          // Never leave an invisible live key when browser storage is blocked
          // or full. Compensate before the runner hears about the mandate, and
          // discard the submission checkpoint only once revocation is final.
          return await compensateSessionStorageFailure({
            storageError,
            revoke: () => client.revokeSession({
              wallet,
              signer: wallet.signer,
              chainId,
              session: session as Parameters<typeof client.revokeSession>[0]['session'],
            }),
            afterConfirmedRevocation: () => clearSessionGrantCheckpoint(
              chainId,
              wallet.address as `0x${string}`,
              agent.managedAgent,
            ),
          });
        }
        granted = { session, local };
        setGrantedActivation(granted);
      }

      // 3. Register the account so the agent starts managing it.
      setPhase('Handing the mandate to the agent…');
      await registerManaged(agent.managedAgent, {
        account: wallet.address as `0x${string}`,
        chainId,
        session: granted.session,
      });
      markRegistered(granted.local.id);
      clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
      setStep('active');
      toast({ title: 'Funds under management', detail: `${agent.name} is now working your deposit`, kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Activation failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(false);
      setPhase('');
    }
  }

  const activeGasQuote = gasQuote?.asset === fundingAsset ? gasQuote : null;
  const gasConversionRequired = fundingAsset === 'BNB'
    || nativeBal == null
    || activeGasQuote == null
    || nativeBal < activeGasQuote.gasReserveWei + activeGasQuote.bootstrapFeeWei;
  const grossFunding = balances[fundingAsset];
  const requiredFunding = activeGasQuote && gasConversionRequired ? activeGasQuote.totalGasInput : 0n;
  const fundingReady = grossFunding != null && grossFunding > requiredFunding;
  const stepIndex = { wallet: 0, deposit: 1, active: 2 }[step];
  const activationLabel = preparedFunding?.status === 'submitted'
    ? 'Check funding status'
    : relayGrantStatus?.status === 'pending'
      ? 'Check mandate status'
      : relayGrantStatus?.status === 'confirmed'
        ? 'Finish activation'
        : relayGrantStatus?.status === 'failed'
          ? 'Retry agent mandate'
          : (preparedFunding?.status === 'confirmed' || recoveredFunding !== null) && !grantedActivation
            ? 'Continue: grant agent mandate'
            : grantedActivation
              ? 'Retry agent handoff'
              : agent.submitLabel ?? 'Put funds under management';
  const resetCancelsPending = rotatedGrantReset?.cancellation === true;
  const primaryBtn =
    'rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)] disabled:opacity-50 disabled:shadow-none';

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-2xl border border-border bg-surface p-6">
        {bestApyPct != null && bestVenue && (
          <div className="mb-5 flex items-center justify-between rounded-lg border border-success/20 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent)] px-3 py-2.5">
            <span className="text-xs text-muted-2">
              {automationReady
                ? `Live ${token} yield, auto-rotated to the best venue`
                : `Live ${token} venue rates · managed activation paused`}
            </span>
            <span className="tabular font-mono text-sm font-semibold text-success">
              ~{bestApyPct.toFixed(2)}% APY <span className="text-muted-2">({bestVenue})</span>
            </span>
          </div>
        )}
        <Stepper current={stepIndex} />

        {step === 'wallet' && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Your managed account</h2>
              <p className="mt-1 text-sm text-muted">
                Funds stay in a smart account secured by your passkey. {agent.name}{' '}
                gets a scoped key that can only route your {token} between lending
                venues, never send it anywhere but back to you.
              </p>
            </div>
            {!automationReady && (
              <p className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm text-primary">
                New managed sessions are temporarily paused. The existing router is recovery-only while
                the debt-complete replacement is deployed and verified.
              </p>
            )}
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-2">One asset to deposit</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {FUNDING_ASSETS.map((asset) => (
                  <button
                    key={asset}
                    onClick={() => setFundingAsset(asset)}
                    aria-pressed={fundingAsset === asset}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
                      fundingAsset === asset
                        ? 'border-primary/50 bg-primary/10 text-foreground shadow-[0_0_16px_rgba(245,158,11,0.15)]'
                        : 'border-border-strong text-muted-2 hover:border-primary/30 hover:text-foreground'
                    }`}
                  >
                    <TokenLogo symbol={asset} className="h-6 w-6" />
                    {asset}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-2">
                {fundingAsset === 'USDC' ? 'USDC remains USDC.' : `${fundingAsset} is prepared into USDT.`}{' '}
                Gas is allocated from the same deposit.
              </p>
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-2">Network</p>
              <div className="inline-flex rounded-lg border border-border-strong p-0.5">
                <span className="rounded-md bg-primary/15 px-3 py-1.5 text-sm text-primary">
                  BNB Smart Chain
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-2">
                Live venue management runs on BNB Chain mainnet. Try it with a
                few dollars of {token}.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 pt-1">
              <button
                onClick={() => connectPasskey('recover')}
                disabled={busy || !automationReady}
                className={primaryBtn}
              >
                {busy ? 'Waiting for passkey…' : 'Use existing funded account'}
              </button>
              <button
                onClick={() => connectPasskey('create')}
                disabled={busy || !automationReady}
                className="rounded-lg border border-border-strong px-4 py-2.5 text-sm transition-colors hover:border-primary/40 disabled:opacity-50"
              >
                Create new passkey account
              </button>
            </div>
          </section>
        )}

        {step === 'deposit' && wallet && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">
                {recoveredFunding ? 'Funded account found' : 'Fund with one asset'}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {recoveredFunding
                  ? `Agripinaa verified the live ${token} position and BNB reserve. No transaction hash or second deposit is needed.`
                  : `Send only ${fundingAsset}. The account converts the disclosed gas allocation and prepares ${token} for this mandate.`}
              </p>
            </div>
            {recoveredFunding ? (
              <div role="status" className="rounded-xl border border-success/35 bg-success/10 p-4 text-sm">
                <div className="flex items-center gap-2 font-semibold text-success">
                  <VerifiedIcon className="h-5 w-5" />
                  {recoveredFunding.formattedPrincipal} {token} under management
                </div>
                <p className="mt-2 break-all font-mono text-xs text-muted">{wallet.address}</p>
              </div>
            ) : (
              <FundingDeposit
                address={wallet.address as `0x${string}`}
                asset={fundingAsset}
                balances={balances}
                gasQuote={activeGasQuote}
                gasConversionRequired={gasConversionRequired}
                preparedPlan={preparedFunding?.plan}
                preparationStatus={preparedFunding?.status}
                preparationTransactionHash={preparedFunding?.status === 'confirmed'
                  ? preparedFunding.transactionHash
                  : undefined}
                quoteError={quoteError}
                locked={busy || preparedFunding !== null}
                onAssetChange={(asset) => {
                  if (!busy && !preparedFunding) setFundingAsset(asset);
                }}
              />
            )}
            <p className="text-xs leading-relaxed text-muted-2">
              {recoveredFunding
                ? `This mandate resumes management of the recovered ${token} position.`
                : <>This mandate manages the {token} produced from the account&apos;s selected deposit. To manage only part,
                  use a separate account funded with that amount.</>}
            </p>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-muted-2">Mandate expires after</span>
              <div className="inline-flex rounded-lg border border-border-strong p-0.5">
                {[
                  { h: 24, label: '24h' },
                  { h: 168, label: '7d' },
                  { h: 720, label: '30d' },
                ].map((o) => (
                  <button
                    key={o.h}
                    onClick={() => setHours(o.h)}
                    disabled={busy || grantedActivation !== null}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      hours === o.h ? 'bg-primary/15 text-primary' : 'text-muted-2 hover:text-foreground'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </label>
            {busy && <ActivationProgress phase={phase} />}
            {relayGrantStatus && (
              <RelayGrantNotice grant={relayGrantStatus} onStatusChange={setRelayGrantStatus} />
            )}
            {relayRevocationStatus && (
              <RelayGrantNotice
                grant={relayRevocationStatus}
                operation={resetCancelsPending ? 'cancellation' : 'revocation'}
                onStatusChange={setRelayRevocationStatus}
              />
            )}
            {rotatedGrantReset && (
              <div role="alert" className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs leading-relaxed">
                <p className="font-semibold text-primary">A fresh {agent.name} manager key is ready</p>
                <p className="mt-1 text-foreground">
                  {rotatedGrantReset.checkpoint.status === 'revoking'
                    ? resetCancelsPending
                      ? 'The stalled mandate cancellation is saved above. Your funded account stays unchanged, and no replacement will be submitted until the stalled nonce is permanently invalid.'
                      : 'The old mandate revocation is saved above. Your funded account stays unchanged, and no replacement will be submitted until that relay outcome is final.'
                    : rotatedGrantReset.requiresRevocation
                      ? resetCancelsPending
                        ? 'The previous mandate is stalled at the relay. Continuing permanently cancels its nonce first, then asks you to sign the replacement.'
                        : 'The previous mandate is active. Continuing saves and confirms its revocation first, then asks you to sign the replacement.'
                      : <>Resetting removes only the old browser checkpoint. Your funded account and tokens stay unchanged.
                      The old relay request may still appear on-chain until{' '}
                      {new Date(rotatedGrantReset.checkpoint.expiry * 1_000).toLocaleString()}, but its private key has
                      been removed from the live runner.</>}
                </p>
              </div>
            )}
            <button
              onClick={() => void activate(rotatedGrantReset ?? undefined)}
              disabled={busy || !automationReady || (!recoveredFunding && !preparedFunding && (!activeGasQuote || !fundingReady))}
              aria-busy={busy}
              aria-describedby={busy ? 'activation-progress' : undefined}
              className={`${primaryBtn} ${busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'}`}
            >
              {busy
                ? 'Activation in progress…'
                : rotatedGrantReset?.checkpoint.status === 'revoking'
                  ? relayRevocationStatus?.status === 'failed'
                    ? resetCancelsPending ? 'Retry cancellation' : 'Retry revocation and replacement (2 taps)'
                    : relayRevocationStatus?.status === 'confirmed'
                      ? resetCancelsPending ? 'Verify cancellation and sign replacement' : 'Verify revocation and sign replacement'
                      : resetCancelsPending ? 'Check cancellation status' : 'Check revocation status'
                : rotatedGrantReset?.requiresRevocation
                  ? resetCancelsPending ? 'Cancel stalled mandate (1 tap)' : 'Revoke old and sign replacement (2 taps)'
                  : rotatedGrantReset
                    ? 'Reset and sign replacement mandate'
                    : activationLabel}
            </button>
            <p className="text-xs text-muted-2">
              {recoveredFunding ? 'Current funding verified. Continue with the scoped agent mandate.' : <>
                From a fresh deposit: two passkey taps — funding and router approvals, then the scoped session.
              </>}{' '}
              You can withdraw or revoke any time from your dashboard.
            </p>
          </section>
        )}

        {step === 'active' && (
          <section className="mt-6 space-y-4">
            <div className="flex items-center gap-2">
              <VerifiedIcon className="h-6 w-6 text-success" />
              <h2 className="font-display text-lg font-semibold text-success">Funds under management</h2>
            </div>
            <p className="text-sm text-muted">
              {agent.activeSummary ?? `${agent.name} now reads Venus and Aave each cycle and keeps your ${token} in the higher-yielding venue.`}{' '}
              Your funds never leave your account; track the position and withdraw from your dashboard.
            </p>
            {recoveredExpiry !== null && (
              <p className="text-xs text-muted-2">
                Existing on-chain grant recovered. It expires {new Date(recoveredExpiry * 1000).toLocaleString()}.
              </p>
            )}
            <a href="/dashboard" className={`inline-block ${primaryBtn}`}>
              Open dashboard
            </a>
          </section>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
        )}
      </div>

      <aside className="rounded-2xl border border-border bg-[linear-gradient(180deg,rgba(139,92,246,0.05),transparent_45%)] p-6">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-2">How your funds are protected</h3>
        <ul className="mt-4 space-y-4 text-sm">
          <Assurance icon={<ShieldIcon className="h-5 w-5" />} title="Can't be drained">
            The agent may call only the Router, and every Router action returns
            funds to your account, never to a third party.
          </Assurance>
          <Assurance icon={<CoinsIcon className="h-5 w-5" />} title="Non-custodial">
            Your {token} (or its aToken/vToken) always sits in your own passkey
            account. We never hold it.
          </Assurance>
          <Assurance icon={<LightningIcon className="h-5 w-5" />} title="Withdraw anytime">
            One tap unwinds to plain {token} in your account; revoking the session
            stops the agent instantly.
          </Assurance>
          <Assurance icon={<VerifiedIcon className="h-5 w-5" />} title="On-chain enforced">
            The scope and expiry are enforced by the account contract, not by us.
          </Assurance>
        </ul>
      </aside>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  const steps = ['Account', 'Deposit', 'Active'];
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-medium ${
                done
                  ? 'border-primary bg-primary text-on-primary'
                  : active
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border-strong text-muted-2'
              }`}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={`text-sm ${active || done ? 'text-foreground' : 'text-muted-2'}`}>{label}</span>
            {i < steps.length - 1 && <span className={`h-px flex-1 ${done ? 'bg-primary/50' : 'bg-border'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Assurance({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-primary">
        {icon}
      </span>
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-2">{children}</p>
      </div>
    </li>
  );
}
