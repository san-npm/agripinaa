'use client';

import { isDebtCompleteRouter, routerFor } from '@agripinaa/shared/contracts';
import type { AgentSlug } from '@agripinaa/shared/agents';
import { managedTokenForFunding } from '@agripinaa/shared/funding';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, erc20Abi, http } from 'viem';

import { altanaClient } from '@/lib/altana';
import { bsc } from '@/lib/bsc-chain';
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
import { markRegistered, storeSession } from '@/lib/session-store';
import { waitForManagedPrincipal } from '@/lib/managed-principal';
import { toast } from '@/lib/toast';
import {
  FUNDING_ASSETS,
  buildFundingBootstrapPlan,
  fundingGasQuote,
  type FundingAsset,
  type FundingGasQuote,
} from '@/lib/funding-bootstrap';
import {
  assertFundingCheckpointWritable,
  clearFundingCheckpoint,
  loadFundingCheckpoint,
  saveFundingCheckpoint,
  type ConfirmedFundingCheckpoint,
  type FundingCheckpoint,
} from '@/lib/funding-checkpoint';
import { receiptProvesFundingMainBatch } from '@/lib/funding-receipt';
import { FundingDeposit } from './FundingDeposit';
import { CoinsIcon, LightningIcon, ShieldIcon, TokenLogo, VerifiedIcon } from './icons';

type Step = 'wallet' | 'deposit' | 'active';

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

export function ManagedWizard({ agent }: { agent: ManagedAgentProps }) {
  const [step, setStep] = useState<Step>('wallet');
  const chainId = 56;
  const [fundingAsset, setFundingAsset] = useState<FundingAsset>('USDT');
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
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
    () => createPublicClient({ chain: bsc, transport: http() }),
    [],
  );

  async function connectPasskey(mode: 'create' | 'recover') {
    if (!automationReady) {
      setError('Managed activation is paused while the debt-complete router is deployed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = altanaClient();
      const w =
        mode === 'create'
          ? await client.createPasskeyWallet({ name: 'Agripinaa' })
          : await client.recoverFromPasskey();
      const checkpoint = loadFundingCheckpoint(chainId, w.address as `0x${string}`, agent.managedAgent);
      if (checkpoint?.expectedTotalWei !== undefined) {
        setFundingAsset(checkpoint.plan.input);
        setPreparedFunding(checkpoint);
      } else {
        setPreparedFunding(null);
      }
      setWallet(w);
      setStep('deposit');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (step !== 'deposit' || !wallet) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const tokenAssets = FUNDING_ASSETS.filter((symbol): symbol is Exclude<FundingAsset, 'BNB'> => symbol !== 'BNB');
        const [n, ...assets] = await Promise.all([
          publicClient().getBalance({ address: wallet.address as `0x${string}` }),
          ...tokenAssets.map((symbol) => publicClient().readContract({
            address: TOKENS_BSC[symbol]!.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as `0x${string}`],
          })),
        ]);
        if (!cancelled) {
          setNativeBal(n);
          setBalances({
            BNB: n,
            BTCB: assets[tokenAssets.indexOf('BTCB')]!,
            USDT: assets[tokenAssets.indexOf('USDT')]!,
            USDC: assets[tokenAssets.indexOf('USDC')]!,
          });
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
  }, [step, wallet, publicClient]);

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

  async function activate() {
    if (!wallet) return;
    if (!automationReady) {
      setError('Managed activation is paused while the debt-complete router is deployed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fundingClient = publicClient();
      const router = routerFor(chainId, token)!;
      let prepared = preparedFunding;
      if (prepared?.status === 'submitted') {
        setPhase('Resuming the already-submitted funding transaction…');
        const resumed = await altanaClient().waitForExecution({
          callsId: prepared.callsId,
          chainId,
        });
        if (resumed.status === 'PENDING') {
          throw new Error('The funding transaction is still pending. It is saved safely; retry activation without depositing again.');
        }
        if (resumed.status === 'FAILED' || !resumed.transactionHash) {
          clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
          setPreparedFunding(null);
          throw new Error('The saved funding transaction failed. No strategy funding was recorded; review the quote and retry.');
        }
        const receipt = await fundingClient.waitForTransactionReceipt({
          hash: resumed.transactionHash,
          timeout: 30_000,
        });
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
      if (!prepared) {
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
        const displayedQuote = gasQuote?.asset === fundingAsset ? gasQuote : null;
        if (!displayedQuote || displayedQuote.expiresAt <= Date.now() + 5_000) {
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
        setPhase(plan.preCalls.length > 0
          ? 'Preparing your deposit (2 passkey confirmations, 1 funding transaction)…'
          : 'Preparing your deposit (1 passkey confirmation, 1 funding transaction)…');
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
        const receipt = await fundingClient.waitForTransactionReceipt({
          hash: fundingResult.transactionHash,
          timeout: 30_000,
        });
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

      if (prepared.status !== 'confirmed') {
        throw new Error('The saved funding transaction has not confirmed yet. Retry activation without depositing again.');
      }
      const expectedTotalWei = prepared.expectedTotalWei;
      if (expectedTotalWei === undefined) {
        clearFundingCheckpoint(chainId, wallet.address as `0x${string}`, agent.managedAgent);
        setPreparedFunding(null);
        throw new Error('The saved managed-funding checkpoint is incomplete. Review the account balance before retrying.');
      }

      const client = altanaClient();
      let granted = grantedActivation;
      if (!granted) {
        // 2. Fetch the agent's manager key and grant a router-scoped session to
        // it via a verify-only stub (the agent key never enters the browser).
        setPhase('Granting the managed session (1 passkey tap)…');
        const manager = await fetchManagerKey(agent.managedAgent, token);
        const scope = buildManagedScope({ chainId, hours, token });
        const summary = describeScope(scope);
        // Once grantSession returns, the very next operation is durable
        // recovery storage—there is no network await that could leave a live
        // key invisible to the owner.
        const activationPosition = await waitForManagedPrincipal(
          () => readManagedPosition(
            wallet.address as `0x${string}`,
            chainId,
            token,
            router.address,
            fundingClient as never,
            prepared.receiptBlockNumber,
          ),
          expectedTotalWei,
        );
        const session = await client.grantSession({
          wallet,
          signer: wallet.signer,
          chainId,
          sessionSigner: verifyOnlyStub(manager.address, manager.publicKey) as never,
          ...scope,
        });
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
        } catch (storageError) {
          // Never leave an invisible live key when browser storage is blocked
          // or full. Compensate before the runner hears about the mandate.
          let revoked: { status: string };
          try {
            revoked = await client.revokeSession({
              wallet,
              signer: wallet.signer,
              chainId,
              session: session as Parameters<typeof client.revokeSession>[0]['session'],
            });
          } catch (revokeError) {
            throw new Error(
              `CRITICAL: local recovery storage failed and automatic revocation also failed. Revoke the new key from the wallet interface immediately. ${revokeError instanceof Error ? revokeError.message : ''}`.trim(),
            );
          }
          if (revoked.status !== 'CONFIRMED') {
            throw new Error('Local recovery storage failed and the compensating session revocation did not confirm.');
          }
          throw new Error(`Local recovery storage failed; the new session was revoked. ${storageError instanceof Error ? storageError.message : ''}`.trim());
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
  const preCallConfirmationRequired = fundingAsset !== 'BNB'
    && activeGasQuote != null
    && nativeBal != null
    && nativeBal < activeGasQuote.gasReserveWei + activeGasQuote.bootstrapFeeWei;
  const stepIndex = { wallet: 0, deposit: 1, active: 2 }[step];
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
              <button onClick={() => connectPasskey('create')} disabled={busy || !automationReady} className={primaryBtn}>
                {busy ? 'Waiting for passkey…' : 'Create with passkey'}
              </button>
              <button
                onClick={() => connectPasskey('recover')}
                disabled={busy || !automationReady}
                className="rounded-lg border border-border-strong px-4 py-2.5 text-sm transition-colors hover:border-primary/40 disabled:opacity-50"
              >
                I already have one
              </button>
            </div>
          </section>
        )}

        {step === 'deposit' && wallet && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Fund with one asset</h2>
              <p className="mt-1 text-sm text-muted">
                Send only {fundingAsset}. The account converts the disclosed gas allocation and prepares {token} for this mandate.
              </p>
            </div>
            <FundingDeposit
              address={wallet.address as `0x${string}`}
              asset={fundingAsset}
              balances={balances}
              gasQuote={activeGasQuote}
              gasConversionRequired={gasConversionRequired}
              preparedPlan={preparedFunding?.plan}
              preparationStatus={preparedFunding?.status}
              quoteError={quoteError}
              locked={busy || preparedFunding !== null}
              onAssetChange={(asset) => {
                if (!busy && !preparedFunding) setFundingAsset(asset);
              }}
            />
            <p className="text-xs leading-relaxed text-muted-2">
              This mandate manages the {token} produced from the account&apos;s selected deposit. To manage only part,
              use a separate account funded with that amount.
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
            <button
              onClick={activate}
              disabled={busy || !automationReady || (!preparedFunding && (!activeGasQuote || !fundingReady))}
              className={primaryBtn}
            >
              {busy ? phase || 'Working…' : agent.submitLabel ?? 'Put funds under management'}
            </button>
            <p className="text-xs text-muted-2">
              From a fresh deposit: {preCallConfirmationRequired ? 'three' : 'two'} passkey taps —
              funding and router approvals, the scoped session
              {preCallConfirmationRequired ? ', and the separately signed relay-fee conversion' : ''}.
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
