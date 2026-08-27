'use client';

import { managedStrategyFor, type ManagedStrategySlug } from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, erc20Abi, http, type Hex } from 'viem';

import { altanaClient } from '@/lib/altana';
import { bsc } from '@/lib/bsc-chain';
import { fetchManagerKey, registerManaged, verifyOnlyStub } from '@/lib/managed';
import {
  approveStrategyVenues,
  buildStrategyScope,
  describeScope,
} from '@/lib/managed-strategy';
import { markRegistered, storeSession } from '@/lib/session-store';
import { compensateSessionStorageFailure } from '@/lib/session-storage-recovery';
import { toast } from '@/lib/toast';
import { CoinsIcon, ShieldIcon, TokenLogo, VerifiedIcon } from './icons';

type Step = 'wallet' | 'deposit' | 'active';
const MIN_NATIVE = 500_000_000_000_000n;

interface StrategyAgentProps {
  chainId: number;
  tokenId: string;
  name: string;
  slug: ManagedStrategySlug;
  submitLabel?: string;
  activeSummary?: string;
}

type PasskeyWallet = Awaited<ReturnType<ReturnType<typeof altanaClient>['createPasskeyWallet']>>;

export function StrategyWizard({ agent }: { agent: StrategyAgentProps }) {
  const strategy = managedStrategyFor(agent.slug)!;
  const [step, setStep] = useState<Step>('wallet');
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [nativeBal, setNativeBal] = useState<bigint | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [hours, setHours] = useState(168);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const publicClient = useCallback(
    () => createPublicClient({ chain: bsc, transport: http() }),
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
        const [native, ...assets] = await Promise.all([
          client.getBalance({ address: wallet.address as Hex }),
          ...strategy.depositTokens.map((symbol) => client.readContract({
            address: TOKENS_BSC[symbol]!.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as Hex],
          })),
        ]);
        if (!cancelled) {
          setNativeBal(native);
          setBalances(Object.fromEntries(strategy.depositTokens.map((symbol, index) => [symbol, assets[index]!])));
        }
      } catch {
        // A later poll retries transient RPC failures.
      }
    };
    void tick();
    const timer = window.setInterval(tick, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [publicClient, step, strategy.depositTokens, wallet]);

  async function activate() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      setPhase('Approving the fixed strategy venues (1 passkey tap)…');
      await approveStrategyVenues(wallet as never, agent.slug, 56);

      setPhase('Granting the agent-specific session (1 passkey tap)…');
      const manager = await fetchManagerKey(agent.slug, 'USDT');
      const scope = buildStrategyScope(agent.slug, hours);
      const summary = describeScope(scope);
      const client = altanaClient();
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

      if (strategy.signatureCheckers.length > 0) {
        setPhase('Authorizing Ophis order validation (1 passkey tap)…');
        for (const checker of strategy.signatureCheckers) {
          const approved = await client.approveSignatureChecker({
            wallet,
            signer: wallet.signer,
            session: session as Parameters<typeof client.approveSignatureChecker>[0]['session'],
            checker,
            chainId: 56,
          });
          if (approved.status !== 'CONFIRMED') {
            throw new Error('Ophis signature-checker approval did not confirm. The saved session remains revocable from your dashboard.');
          }
        }
      }

      setPhase('Handing the mandate to the live agent…');
      await registerManaged(agent.slug, { account: wallet.address as Hex, chainId: 56, session });
      markRegistered(local.id);
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

  const fmt = (value: bigint | null | undefined) => value == null ? '…' : (Number(value) / 1e18).toFixed(6);
  const gasReady = nativeBal != null && nativeBal >= MIN_NATIVE;
  const assetsReady = strategy.depositTokens.every((symbol) => (balances[symbol] ?? 0n) > 0n);
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
              <h2 className="font-display text-lg font-semibold">Fund the strategy account</h2>
              <p className="mt-1 text-sm text-muted">Send the listed assets and a little BNB for execution gas to:</p>
              <code className="mt-2 block break-all rounded-lg border border-border bg-surface-2 p-3 text-xs text-primary">{wallet.address}</code>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {strategy.depositTokens.map((symbol) => (
                <div key={symbol} className="flex items-center justify-between rounded-lg border border-border bg-surface-2 p-3">
                  <span className="flex items-center gap-2 text-sm"><TokenLogo symbol={symbol} className="h-6 w-6" />{symbol}</span>
                  <span className={(balances[symbol] ?? 0n) > 0n ? 'font-mono text-sm text-success' : 'font-mono text-sm text-muted-2'}>{fmt(balances[symbol])}</span>
                </div>
              ))}
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 p-3">
                <span className="text-sm">BNB gas</span>
                <span className={gasReady ? 'font-mono text-sm text-success' : 'font-mono text-sm text-muted-2'}>{fmt(nativeBal)}</span>
              </div>
            </div>
            <label className="block text-xs text-muted-2">
              Session lifetime
              <select value={hours} onChange={(event) => setHours(Number(event.target.value))} className="ml-2 rounded border border-border-strong bg-surface-2 px-2 py-1 text-foreground">
                <option value={24}>24 hours</option>
                <option value={168}>7 days</option>
                <option value={720}>30 days</option>
              </select>
            </label>
            <button onClick={activate} disabled={busy || !gasReady || !assetsReady} className={primaryBtn}>
              {busy ? phase || 'Working…' : agent.submitLabel ?? `Activate ${agent.name}`}
            </button>
            <p className="text-xs text-muted-2">
              {strategy.usesOphis ? 'Three' : 'Two'} passkey confirmations: venue approvals, the scoped session{strategy.usesOphis ? ', and Ophis ERC-1271 validation' : ''}.
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
