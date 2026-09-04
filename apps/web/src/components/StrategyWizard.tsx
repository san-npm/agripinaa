'use client';

import { managedStrategyFor, type ManagedStrategySlug } from '@agripinaa/shared/managed-strategies';
import {
  ALTANA_KEYSTORE_CONTROLLER_BSC,
} from '@agripinaa/shared/funding';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, parseAbi, type Hex } from 'viem';

import { altanaClient } from '@/lib/altana';
import { createBscPublicClient, waitForBscTransactionReceipt } from '@/lib/bsc-public-client';
import { fetchManagerKey, registerManaged, verifyOnlyStub } from '@/lib/managed';
import {
  approveStrategyVenues,
  buildStrategyScope,
  describeScope,
} from '@/lib/managed-strategy';
import {
  FUNDING_ASSETS,
  buildFundingBootstrapPlan,
  fundingGasQuote,
  fundingGasQuoteIsCurrent,
  type FundingAsset,
  type FundingGasQuote,
} from '@/lib/funding-bootstrap';
import {
  assertFundingCheckpointWritable,
  clearFundingCheckpoint,
  loadFundingCheckpoint,
  saveFundingCheckpoint,
  shouldPauseAfterFundingConfirmation,
  type ConfirmedFundingCheckpoint,
  type FundingCheckpoint,
} from '@/lib/funding-checkpoint';
import {
  fundingRecoveryHash,
  recoverableStrategyFundingProblem,
  receiptProvesStrategyFundingRecovery,
} from '@/lib/funding-recovery';
import { receiptProvesFundingMainBatch } from '@/lib/funding-receipt';
import { markRegistered, storeSession } from '@/lib/session-store';
import {
  acquireSessionGrantSubmissionLock,
  clearSessionGrantCheckpoint,
  loadSessionGrantCheckpoint,
  retireExpiredRotatedManagerCheckpoint,
  reserveSessionGrantCheckpoint,
  submitSessionGrantCheckpoint,
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
import { toast } from '@/lib/toast';
import { ActivationProgress, FundingDeposit, RelayGrantNotice } from './FundingDeposit';
import { CoinsIcon, ShieldIcon, VerifiedIcon } from './icons';

type Step = 'wallet' | 'deposit' | 'active';

const KEYSTORE_FEE_ABI = parseAbi([
  'function getRegistrationFeeInWei() view returns (uint256)',
]);

interface StrategyAgentProps {
  chainId: number;
  tokenId: string;
  name: string;
  slug: ManagedStrategySlug;
  submitLabel?: string;
  activeSummary?: string;
}

type PasskeyWallet = Awaited<ReturnType<ReturnType<typeof altanaClient>['createPasskeyWallet']>>;
type StrategySession = Awaited<ReturnType<ReturnType<typeof altanaClient>['grantSession']>>;

interface GrantedStrategyActivation {
  session: StrategySession;
  local: ReturnType<typeof storeSession>;
  approvedSignatureCheckers: readonly Hex[];
}

interface RecoveredFunding {
  transactionHash: Hex | null;
}

export function StrategyWizard({
  agent,
  initialRecoveryTxHash = '',
}: {
  agent: StrategyAgentProps;
  initialRecoveryTxHash?: string;
}) {
  const strategy = managedStrategyFor(agent.slug)!;
  const [step, setStep] = useState<Step>('wallet');
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [nativeBal, setNativeBal] = useState<bigint | null>(null);
  const [fundingAsset, setFundingAsset] = useState<FundingAsset>('USDT');
  const [balances, setBalances] = useState<Record<FundingAsset, bigint | null>>({
    BTCB: null,
    BNB: null,
    USDT: null,
    USDC: null,
  });
  const [gasQuote, setGasQuote] = useState<FundingGasQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [preparedFunding, setPreparedFunding] = useState<FundingCheckpoint | null>(null);
  const recoveryTxHash = initialRecoveryTxHash;
  const [recoveredFunding, setRecoveredFunding] = useState<RecoveredFunding | null>(null);
  const [grantedActivation, setGrantedActivation] = useState<GrantedStrategyActivation | null>(null);
  const [relayGrantStatus, setRelayGrantStatus] = useState<RelayCallStatus | null>(null);
  const [recoveredExpiry, setRecoveredExpiry] = useState<number | null>(null);
  const [hours, setHours] = useState(168);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const publicClient = useCallback(
    () => createBscPublicClient(),
    [],
  );

  async function verifyRecoverableAccount(account: Hex) {
    setPhase('Checking the funded account on BNB Chain…');
    const chainClient = publicClient();
    const [nativeBalance, registrationFee, inventoryEntries, allowanceEntries] = await Promise.all([
      chainClient.getBalance({ address: account }),
      chainClient.readContract({
        address: ALTANA_KEYSTORE_CONTROLLER_BSC,
        abi: KEYSTORE_FEE_ABI,
        functionName: 'getRegistrationFeeInWei',
      }),
      Promise.all(strategy.depositTokens.map(async (symbol) => [
        symbol,
        await chainClient.readContract({
          address: TOKENS_BSC[symbol]!.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account],
        }),
      ] as const)),
      Promise.all(strategy.approvals.map(async (approval) => ({
        approval,
        allowance: await chainClient.readContract({
          address: TOKENS_BSC[approval.token]!.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account, approval.spender],
        }),
      }))),
    ]);

    const inventory = Object.fromEntries(inventoryEntries);
    const missing = strategy.depositTokens.filter((symbol) => (inventory[symbol] ?? 0n) === 0n);
    if (missing.length > 0) {
      throw new Error(`No recoverable ${agent.name} funding was found: the account is missing ${missing.join(' and ')}.`);
    }

    const manager = await fetchManagerKey(agent.slug, 'USDT');
    const recoveredSession = await recoverExistingSession({
      account,
      manager,
      scope: buildStrategyScope(agent.slug, hours),
      signatureCheckers: strategy.signatureCheckers,
      signer: verifyOnlyStub(manager.address, manager.publicKey),
      maximumExpiry: null,
    });

    if (recoveredSession) {
      setHours(lifetimeOptionForExistingSession(recoveredSession.session.expiry));
    }
    const problem = recoverableStrategyFundingProblem({
      agentName: agent.name,
      requiredAssets: strategy.depositTokens,
      inventory,
      allowances: allowanceEntries.map(({ allowance }) => allowance),
      nativeBalance,
      registrationFee,
      hasLiveSession: recoveredSession !== null,
    });
    if (problem) throw new Error(problem);
  }

  async function connect(mode: 'create' | 'recover') {
    setBusy(true);
    setError(null);
    setRelayGrantStatus(null);
    try {
      const client = altanaClient();
      const next = mode === 'create'
        ? await client.createPasskeyWallet({ name: `Agripinaa ${agent.name}` })
        : await client.recoverFromPasskey();
      const checkpoint = loadFundingCheckpoint(56, next.address as Hex, agent.slug);
      if (checkpoint) {
        setFundingAsset(checkpoint.plan.input);
        setPreparedFunding(checkpoint);
        setRecoveredFunding(null);
      } else if (mode === 'recover') {
        const transactionHash = recoveryTxHash.trim()
          ? fundingRecoveryHash(recoveryTxHash)
          : null;
        if (recoveryTxHash.trim()) {
          if (!transactionHash) {
            throw new Error('Enter the complete 0x transaction hash from the successful funding transaction.');
          }
          setPhase('Verifying the optional funding transaction…');
          const receipt = await waitForBscTransactionReceipt(transactionHash);
          if (!receiptProvesStrategyFundingRecovery(receipt, next.address as Hex, strategy.approvals)) {
            throw new Error(`That transaction is not a completed ${agent.name} funding bundle for the recovered account.`);
          }
        }
        await verifyRecoverableAccount(next.address as Hex);
        setPreparedFunding(null);
        setRecoveredFunding({ transactionHash });
      } else {
        setPreparedFunding(null);
        setRecoveredFunding(null);
      }
      setWallet(next);
      setStep('deposit');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
        const client = publicClient();
        const tokenAssets = FUNDING_ASSETS.filter((symbol): symbol is Exclude<FundingAsset, 'BNB'> => symbol !== 'BNB');
        const [native, ...assets] = await Promise.all([
          client.getBalance({ address: wallet.address as Hex }),
          ...tokenAssets.map((symbol) => client.readContract({
            address: TOKENS_BSC[symbol]!.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as Hex],
          })),
        ]);
        if (!cancelled) {
          setNativeBal(native);
          setBalances({
            BNB: native,
            BTCB: assets[tokenAssets.indexOf('BTCB')]!,
            USDT: assets[tokenAssets.indexOf('USDT')]!,
            USDC: assets[tokenAssets.indexOf('USDC')]!,
          });
        }
      } catch {
        // A later poll retries transient RPC failures.
      }
    };
    void tick();
    const timer = window.setInterval(tick, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [publicClient, step, wallet]);

  useEffect(() => {
    if (step !== 'deposit' || recoveredFunding) return;
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
  }, [fundingAsset, recoveredFunding, step]);

  async function activate() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    const pauseAfterFunding = shouldPauseAfterFundingConfirmation(
      preparedFunding,
      recoveredFunding !== null,
    );
    const pauseBeforeCheckerApproval = grantedActivation === null;
    try {
      let prepared = preparedFunding;
      if (prepared?.status === 'submitted') {
        setPhase('Resuming the already-submitted funding transaction…');
        const resumed = await altanaClient().waitForExecution({
          callsId: prepared.callsId,
          chainId: 56,
        });
        if (resumed.status === 'PENDING') {
          throw new Error('The funding transaction is still pending. It is saved safely; retry activation without depositing again.');
        }
        if (resumed.status === 'FAILED' || !resumed.transactionHash) {
          clearFundingCheckpoint(56, wallet.address as Hex, agent.slug);
          setPreparedFunding(null);
          throw new Error('The saved funding transaction failed. No strategy funding was recorded; review the quote and retry.');
        }
        const receipt = await waitForBscTransactionReceipt(resumed.transactionHash);
        if (
          receipt.status !== 'success'
          || !receiptProvesFundingMainBatch(
            receipt.logs as never,
            wallet.address as Hex,
            prepared.plan.nativeReserveOutputWei,
          )
        ) {
          clearFundingCheckpoint(56, wallet.address as Hex, agent.slug);
          setPreparedFunding(null);
          throw new Error('The saved relay transaction did not complete the account funding calls. Review the balance and retry; no successful funding checkpoint was retained.');
        }
        const confirmed: ConfirmedFundingCheckpoint = {
          ...prepared,
          status: 'confirmed',
          transactionHash: resumed.transactionHash,
          receiptBlockNumber: receipt.blockNumber,
        };
        saveFundingCheckpoint(56, wallet.address as Hex, agent.slug, confirmed);
        setPreparedFunding(confirmed);
        prepared = confirmed;
      }
      if (!prepared && !recoveredFunding) {
        setPhase('Building the deposit preparation…');
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
          account: wallet.address as Hex,
          agent: agent.slug,
          input: fundingAsset,
          grossInput: balances[fundingAsset] ?? 0n,
          nativeBalance: nativeBal ?? 0n,
          gasQuote: displayedQuote,
          quoteClient: publicClient() as never,
          merchantUrl: new URL('/api/funding/merchant', window.location.origin).toString(),
        });
        setPhase('Preparing your deposit (1 passkey confirmation, 1 funding transaction)…');
        try {
          assertFundingCheckpointWritable(56, wallet.address as Hex, agent.slug, plan);
        } catch {
          throw new Error('This browser cannot save a funding recovery checkpoint. Enable site storage before confirming the transaction.');
        }
        const result = await approveStrategyVenues(wallet as never, agent.slug, 56, {
          ...plan,
          onSubmitted: (callsId) => {
            const submitted: FundingCheckpoint = {
              status: 'submitted',
              callsId,
              plan,
            };
            setPreparedFunding(submitted);
            saveFundingCheckpoint(56, wallet.address as Hex, agent.slug, submitted);
          },
        });
        if (!result.transactionHash) {
          throw new Error('The confirmed funding bundle returned no transaction hash.');
        }
        const receipt = await waitForBscTransactionReceipt(result.transactionHash);
        if (
          receipt.status !== 'success'
          || !receiptProvesFundingMainBatch(
            receipt.logs as never,
            wallet.address as Hex,
            plan.nativeReserveOutputWei,
          )
        ) {
          clearFundingCheckpoint(56, wallet.address as Hex, agent.slug);
          setPreparedFunding(null);
          throw new Error(
            'The relay transaction did not complete the account funding calls. Review the balance and retry; no successful funding checkpoint was retained.',
          );
        }
        const confirmed: ConfirmedFundingCheckpoint = {
          status: 'confirmed',
          callsId: result.callsId,
          plan,
          transactionHash: result.transactionHash,
          receiptBlockNumber: receipt.blockNumber,
        };
        // Persist only after an inner-call effect proves the atomic main batch
        // completed. A successful outer orchestrator receipt is insufficient.
        try {
          saveFundingCheckpoint(56, wallet.address as Hex, agent.slug, confirmed);
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

      const client = altanaClient();
      let granted = grantedActivation;
      if (!granted) {
        setPhase('Checking for an existing agent session…');
        const manager = await fetchManagerKey(agent.slug, 'USDT');
        let scope = buildStrategyScope(agent.slug, hours);
        const sessionSigner = verifyOnlyStub(manager.address, manager.publicKey);
        let grantCheckpoint = await retireExpiredRotatedManagerCheckpoint(
          56,
          wallet.address as Hex,
          agent.slug,
          manager.publicKey,
        );
        if (grantCheckpoint) scope = { ...scope, expiry: grantCheckpoint.expiry };
        const relayGrant = grantCheckpoint?.status === 'submitted'
          ? null
          : await findRelaySessionGrant({
            account: wallet.address as Hex,
            publicKey: manager.publicKey,
          });
        if (grantCheckpoint?.status === 'reserved' && relayGrant) {
          submitSessionGrantCheckpoint(
            56,
            wallet.address as Hex,
            agent.slug,
            manager.publicKey,
            grantCheckpoint.expiry,
            relayGrant.callsId,
          );
          grantCheckpoint = loadSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
        }
        let recovered = await recoverExistingSession({
          account: wallet.address as Hex,
          manager,
          scope,
          signatureCheckers: strategy.signatureCheckers,
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
            clearSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
            if (relayGrantStatus?.status !== 'failed') {
              setRelayGrantStatus(outcome);
              return;
            }
            setRelayGrantStatus(null);
            grantCheckpoint = null;
            scope = buildStrategyScope(agent.slug, hours);
            recovered = await recoverExistingSession({
              account: wallet.address as Hex,
              manager,
              scope,
              signatureCheckers: strategy.signatureCheckers,
              signer: sessionSigner,
            });
          } else {
            setRelayGrantStatus(outcome);
            setPhase('Recovering the relay-confirmed session on BNB Chain…');
            recovered = await recoverExistingSession({
              account: wallet.address as Hex,
              manager,
              scope,
              signatureCheckers: strategy.signatureCheckers,
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
            account: wallet.address as Hex,
            manager,
            scope,
            signatureCheckers: strategy.signatureCheckers,
            signer: sessionSigner,
          });
          if (!recovered) {
            return;
          }
        }
        const recoveredExisting = recovered !== null;
        let session: StrategySession;
        let approvedSignatureCheckers: readonly Hex[];
        if (recovered) {
          setRelayGrantStatus(null);
          setPhase('Recovering the confirmed agent session…');
          session = recovered.session as StrategySession;
          approvedSignatureCheckers = recovered.approvedSignatureCheckers;
          setRecoveredExpiry(recovered.session.expiry);
        } else {
          setRelayGrantStatus(null);
          setPhase('Granting the agent-specific session (1 passkey tap)…');
          let releaseGrantLock: (() => Promise<void>) | null = null;
          try {
            try {
              session = await client.grantSession({
                wallet,
                signer: wallet.signer,
                chainId: 56,
                sessionSigner: sessionSigner as never,
                onBeforeSubmit: async () => {
                  releaseGrantLock = await acquireSessionGrantSubmissionLock(
                    56,
                    wallet.address as Hex,
                    agent.slug,
                    manager.publicKey,
                    scope.expiry,
                  );
                  const concurrentGrant = await findRelaySessionGrant({
                    account: wallet.address as Hex,
                    publicKey: manager.publicKey,
                  });
                  if (concurrentGrant) {
                    throw new Error('This manager grant was submitted by another tab or device. Activation stopped before sending a duplicate; retry to recover it.');
                  }
                  reserveSessionGrantCheckpoint(
                    56,
                    wallet.address as Hex,
                    agent.slug,
                    manager.publicKey,
                    scope.expiry,
                  );
                },
                onSubmitted: async (callsId) => {
                  submitSessionGrantCheckpoint(
                    56,
                    wallet.address as Hex,
                    agent.slug,
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
              const submitted = loadSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
              if (submitted?.status !== 'submitted') {
                throw new Error('The confirmed agent mandate has no saved relay reference. Activation stopped before handoff.');
              }
              const outcome = await readRelayCallStatus({ callsId: submitted.callsId })
                .catch((): RelayCallStatus => ({ callsId: submitted.callsId, status: 'pending' }));
              if (outcome.status !== 'confirmed') {
                if (outcome.status === 'failed') {
                  clearSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
                }
                setRelayGrantStatus(outcome);
                return;
              }
              setRelayGrantStatus(null);
            } catch (grantError) {
              const submitted = loadSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
              if (submitted?.status !== 'submitted') throw grantError;
              const outcome = await readRelayCallStatus({ callsId: submitted.callsId })
                .catch((): RelayCallStatus => ({ callsId: submitted.callsId, status: 'pending' }));
              if (outcome.status === 'failed') {
                clearSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
              }
              setRelayGrantStatus(outcome);
              return;
            }
          } finally {
            await (releaseGrantLock as (() => Promise<void>) | null)?.();
          }
          approvedSignatureCheckers = [];
        }
        const summary = describeScope({ ...scope, expiry: session.expiry });
        let local: ReturnType<typeof storeSession>;
        try {
          local = storeSession({
            session,
            chainId: 56,
            agent: { chainId: agent.chainId, tokenId: agent.tokenId, name: agent.name, slug: agent.slug },
            scope: {
              allowlist: strategy.callScopes.map((call) => call.to),
              capFormatted: `Dedicated strategy-account inventory; ${summary.capFormatted} direct-call cap`,
              expiresAt: summary.expiresAt,
            },
          });
          clearSessionGrantCheckpoint(56, wallet.address as Hex, agent.slug);
        } catch (storageError) {
          if (recoveredExisting) {
            throw new Error(
              `The existing on-chain session is valid, but this browser could not save its recovery record. No duplicate grant was submitted. ${storageError instanceof Error ? storageError.message : ''}`.trim(),
            );
          }
          return await compensateSessionStorageFailure({
            storageError,
            revoke: () => client.revokeSession({
              wallet,
              signer: wallet.signer,
              chainId: 56,
              session: session as Parameters<typeof client.revokeSession>[0]['session'],
            }),
            afterConfirmedRevocation: () => clearSessionGrantCheckpoint(
              56,
              wallet.address as Hex,
              agent.slug,
            ),
          });
        }
        granted = { session, local, approvedSignatureCheckers };
        setGrantedActivation(granted);
      }
      if (!granted) throw new Error('Agent session recovery did not produce a usable mandate.');
      let activeGrant = granted;

      const missingSignatureCheckers = strategy.signatureCheckers.filter((checker) =>
        !activeGrant.approvedSignatureCheckers.some((approved) =>
          approved.toLowerCase() === checker.toLowerCase(),
        ),
      );
      if (pauseBeforeCheckerApproval && missingSignatureCheckers.length > 0) {
        toast({
          title: 'Agent mandate confirmed',
          detail: 'Continue below to authorize Ophis order validation.',
          kind: 'success',
        });
        return;
      }
      if (missingSignatureCheckers.length > 0) {
        setPhase('Authorizing Ophis order validation (1 passkey tap)…');
        for (const checker of missingSignatureCheckers) {
          const approved = await client.approveSignatureChecker({
            wallet,
            signer: wallet.signer,
            session: activeGrant.session as Parameters<typeof client.approveSignatureChecker>[0]['session'],
            checker,
            chainId: 56,
          });
          if (approved.status !== 'CONFIRMED') {
            throw new Error('Ophis signature-checker approval did not confirm. The saved session remains revocable from your dashboard.');
          }
          activeGrant = {
            ...activeGrant,
            approvedSignatureCheckers: [...activeGrant.approvedSignatureCheckers, checker],
          };
          setGrantedActivation(activeGrant);
        }
      }

      setPhase('Handing the mandate to the live agent…');
      await registerManaged(agent.slug, {
        account: wallet.address as Hex,
        chainId: 56,
        session: activeGrant.session,
      });
      markRegistered(activeGrant.local.id);
      clearFundingCheckpoint(56, wallet.address as Hex, agent.slug);
      setStep('active');
      toast({ title: `${agent.name} activated`, detail: 'The runner accepted your mandate', kind: 'success' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast({ title: 'Activation failed', detail: message.slice(0, 80), kind: 'error' });
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
  const assetsReady = grossFunding != null && grossFunding > requiredFunding;
  const freshConfirmationCount = 2 + strategy.signatureCheckers.length;
  const checkerAuthorizationPending = grantedActivation !== null
    && strategy.signatureCheckers.some((checker) =>
      !grantedActivation.approvedSignatureCheckers.some((approved) =>
        approved.toLowerCase() === checker.toLowerCase(),
      ),
    );
  const activationLabel = preparedFunding?.status === 'submitted'
    ? 'Check funding status'
    : relayGrantStatus?.status === 'pending'
      ? 'Check mandate status'
      : relayGrantStatus?.status === 'confirmed'
        ? 'Finish activation'
        : relayGrantStatus?.status === 'failed'
          ? 'Retry agent mandate'
          : checkerAuthorizationPending
            ? 'Continue: authorize Ophis'
            : grantedActivation
              ? 'Retry agent handoff'
              : recoveredFunding || preparedFunding?.status === 'confirmed'
                ? 'Continue: grant agent mandate'
                : agent.submitLabel ?? `Activate ${agent.name}`;
  const primaryBtn = 'rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)] disabled:opacity-50 disabled:shadow-none';

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-2xl border border-border bg-surface p-6">
        {step === 'wallet' && (
          <section className="space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Your strategy account</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">{strategy.summary}</p>
            </div>
            <p className="rounded-lg border border-primary/35 bg-primary/10 p-3 text-xs leading-relaxed text-muted">
              <span className="font-semibold text-primary">Dedicated-account boundary.</span>{' '}
              {strategy.riskNote} The session is time-bounded and revocable, but it controls the capital approved to these venues.
            </p>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => connect('create')} disabled={busy} className={primaryBtn}>
                {busy ? 'Waiting for passkey…' : 'Create dedicated account'}
              </button>
              <button onClick={() => connect('recover')} disabled={busy} className="rounded-lg border border-border-strong px-4 py-2.5 text-sm hover:border-primary/40 disabled:opacity-50">
                Find funded account with passkey
              </button>
            </div>
            <p className="rounded-xl border border-primary/35 bg-primary/10 p-4 text-xs leading-relaxed text-muted">
              Already funded? Use <strong className="font-semibold text-foreground">Find funded account with passkey</strong>.
              Agripinaa checks the account&apos;s live session, inventory, approvals, and BNB reserve—no transaction hash or second deposit.
            </p>
          </section>
        )}

        {step === 'deposit' && wallet && (
          <section className="space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">
                {recoveredFunding ? 'Funding recovered' : 'Fund with one asset'}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {recoveredFunding
                  ? 'The completed on-chain funding bundle belongs to this passkey account. Continue with the scoped mandate.'
                  : 'Choose BTCB, BNB, USDT, or USDC. Agripinaa prepares this strategy\'s inventory and gas from that single deposit.'}
              </p>
            </div>
            {recoveredFunding ? (
              <div role="status" className="rounded-xl border border-success/35 bg-success/10 p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-success/15 text-success">
                    <VerifiedIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-success">Funded account verified</p>
                    {recoveredFunding.transactionHash && (
                      <a
                        href={`https://bscscan.com/tx/${recoveredFunding.transactionHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 block truncate font-mono text-xs text-muted underline decoration-border-strong underline-offset-2 hover:text-foreground"
                      >
                        {recoveredFunding.transactionHash}
                      </a>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  Account {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)} has a recoverable
                  funding or live-session state. No new transfer or funding approval will be requested.
                </p>
              </div>
            ) : (
              <FundingDeposit
                address={wallet.address as Hex}
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
            <p className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted-2">
              {strategy.fundingNote} Native BNB is wrapped internally when a pool requires WBNB.
            </p>
            <label className="block text-xs text-muted-2">
              Session lifetime
              <select
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
                disabled={busy || grantedActivation !== null}
                className="ml-2 rounded border border-border-strong bg-surface-2 px-2 py-1 text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value={24}>24 hours</option>
                <option value={168}>7 days</option>
                <option value={720}>30 days</option>
              </select>
            </label>
            {busy && <ActivationProgress phase={phase} />}
            {relayGrantStatus && (
              <RelayGrantNotice grant={relayGrantStatus} onStatusChange={setRelayGrantStatus} />
            )}
            <button
              onClick={activate}
              disabled={busy || (!recoveredFunding && !preparedFunding && (!activeGasQuote || !assetsReady))}
              aria-busy={busy}
              aria-describedby={busy ? 'activation-progress' : undefined}
              className={`${primaryBtn} ${busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'}`}
            >
              {busy ? 'Activation in progress…' : activationLabel}
            </button>
            <p className="text-xs text-muted-2">
              {recoveredFunding ? (
                <>
                  Recovery skips the completed funding step. Continue with the scoped session
                  {strategy.usesOphis ? ' and Ophis ERC-1271 validation' : ''}.
                </>
              ) : (
                <>
                  From a fresh deposit: {freshConfirmationCount} passkey confirmations — funding approvals,
                  the scoped session{strategy.usesOphis ? ', Ophis ERC-1271 validation' : ''}.
                </>
              )}
            </p>
          </section>
        )}

        {step === 'active' && (
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-success/15 text-success"><VerifiedIcon className="h-5 w-5" /></span>
              <h2 className="font-display text-lg font-semibold text-success">Agent active</h2>
            </div>
            <p className="text-sm text-muted">{agent.activeSummary ?? strategy.summary} The grant is saved locally and can be revoked from your dashboard.</p>
            {recoveredExpiry !== null && (
              <p className="text-xs text-muted-2">
                Existing on-chain grant recovered. It expires {new Date(recoveredExpiry * 1000).toLocaleString()}.
              </p>
            )}
            <a href="/dashboard" className={`inline-block ${primaryBtn}`}>Open dashboard</a>
          </section>
        )}

        {error && <p role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      </div>

      <aside className="space-y-3">
        <Info icon={<ShieldIcon className="h-5 w-5" />} title="Agent-specific scope">Only the published selectors for this strategy are granted.</Info>
        <Info icon={<CoinsIcon className="h-5 w-5" />} title="Capital isolated">The dedicated account keeps this mandate separate from your main wallet.</Info>
      </aside>
    </div>
  );
}

function Info({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-border bg-surface p-4"><span className="text-primary">{icon}</span><h3 className="mt-2 text-sm font-semibold">{title}</h3><p className="mt-1 text-xs leading-relaxed text-muted-2">{children}</p></div>;
}
