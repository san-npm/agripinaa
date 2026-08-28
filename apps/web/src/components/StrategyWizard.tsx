'use client';

import { managedStrategyFor, type ManagedStrategySlug } from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, type Hex } from 'viem';

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
import { markRegistered, storeSession } from '@/lib/session-store';
import { compensateSessionStorageFailure } from '@/lib/session-storage-recovery';
import { toast } from '@/lib/toast';
import { FundingDeposit } from './FundingDeposit';
import { CoinsIcon, ShieldIcon, VerifiedIcon } from './icons';

type Step = 'wallet' | 'deposit' | 'active';

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
  approvedCheckerCount: number;
}

export function StrategyWizard({ agent }: { agent: StrategyAgentProps }) {
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
  const [grantedActivation, setGrantedActivation] = useState<GrantedStrategyActivation | null>(null);
  const [hours, setHours] = useState(168);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const publicClient = useCallback(
    () => createBscPublicClient(),
    [],
  );

  async function connect(mode: 'create' | 'recover') {
    setBusy(true);
    setError(null);
    try {
      const client = altanaClient();
      const next = mode === 'create'
        ? await client.createPasskeyWallet({ name: `Agripinaa ${agent.name}` })
        : await client.recoverFromPasskey();
      const checkpoint = loadFundingCheckpoint(56, next.address as Hex, agent.slug);
      if (checkpoint) {
        setFundingAsset(checkpoint.plan.input);
        setPreparedFunding(checkpoint);
      } else {
        setPreparedFunding(null);
      }
      setWallet(next);
      setStep('deposit');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
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
    setBusy(true);
    setError(null);
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
      if (!prepared) {
        setPhase('Building the deposit preparation…');
        const displayedQuote = gasQuote?.asset === fundingAsset ? gasQuote : null;
        if (!displayedQuote || displayedQuote.expiresAt <= Date.now() + 5_000) {
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
        setPhase(plan.preCalls.length > 0
          ? 'Preparing your deposit (2 passkey confirmations, 1 funding transaction)…'
          : 'Preparing your deposit (1 passkey confirmation, 1 funding transaction)…');
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

      if (prepared.status !== 'confirmed') {
        throw new Error('The saved funding transaction has not confirmed yet. Retry activation without depositing again.');
      }

      const client = altanaClient();
      let granted = grantedActivation;
      if (!granted) {
        setPhase('Granting the agent-specific session (1 passkey tap)…');
        const manager = await fetchManagerKey(agent.slug, 'USDT');
        const scope = buildStrategyScope(agent.slug, hours);
        const summary = describeScope(scope);
        const session = await client.grantSession({
          wallet,
          signer: wallet.signer,
          chainId: 56,
          sessionSigner: verifyOnlyStub(manager.address, manager.publicKey) as never,
          ...scope,
        });
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
        } catch (storageError) {
          return await compensateSessionStorageFailure({
            storageError,
            revoke: () => client.revokeSession({
              wallet,
              signer: wallet.signer,
              chainId: 56,
              session: session as Parameters<typeof client.revokeSession>[0]['session'],
            }),
          });
        }
        granted = { session, local, approvedCheckerCount: 0 };
        setGrantedActivation(granted);
      }

      if (granted.approvedCheckerCount < strategy.signatureCheckers.length) {
        setPhase('Authorizing Ophis order validation (1 passkey tap)…');
        for (
          let index = granted.approvedCheckerCount;
          index < strategy.signatureCheckers.length;
          index += 1
        ) {
          const checker = strategy.signatureCheckers[index]!;
          const approved = await client.approveSignatureChecker({
            wallet,
            signer: wallet.signer,
            session: granted.session as Parameters<typeof client.approveSignatureChecker>[0]['session'],
            checker,
            chainId: 56,
          });
          if (approved.status !== 'CONFIRMED') {
            throw new Error('Ophis signature-checker approval did not confirm. The saved session remains revocable from your dashboard.');
          }
          granted = { ...granted, approvedCheckerCount: index + 1 };
          setGrantedActivation(granted);
        }
      }

      setPhase('Handing the mandate to the live agent…');
      await registerManaged(agent.slug, {
        account: wallet.address as Hex,
        chainId: 56,
        session: granted.session,
      });
      markRegistered(granted.local.id);
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
  const preCallConfirmationRequired = fundingAsset !== 'BNB'
    && activeGasQuote != null
    && nativeBal != null
    && nativeBal < activeGasQuote.gasReserveWei + activeGasQuote.bootstrapFeeWei;
  const freshConfirmationCount = 2 + strategy.signatureCheckers.length
    + (preCallConfirmationRequired ? 1 : 0);
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
                Recover this account
              </button>
            </div>
          </section>
        )}

        {step === 'deposit' && wallet && (
          <section className="space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Fund with one asset</h2>
              <p className="mt-1 text-sm text-muted">
                Choose BTCB, BNB, USDT, or USDC. Agripinaa prepares this strategy&apos;s inventory and gas from that single deposit.
              </p>
            </div>
            <FundingDeposit
              address={wallet.address as Hex}
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
            <button
              onClick={activate}
              disabled={busy || (!preparedFunding && (!activeGasQuote || !assetsReady))}
              className={primaryBtn}
            >
              {busy ? phase || 'Working…' : agent.submitLabel ?? `Activate ${agent.name}`}
            </button>
            <p className="text-xs text-muted-2">
              From a fresh deposit: {freshConfirmationCount} passkey confirmations — funding approvals,
              the scoped session{strategy.usesOphis ? ', Ophis ERC-1271 validation' : ''}
              {preCallConfirmationRequired ? ', and the separately signed relay-fee conversion' : ''}.
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
