'use client';

import {
  buildSessionScope,
  describeScope,
} from '@agripinaa/session-kit/scope';
import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, http, isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

import { altanaClient, SUPPORTED_CHAINS } from '@/lib/altana';
import { storeSession } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { CoinsIcon, LightningIcon, ShieldIcon, VerifiedIcon } from './icons';

type Step = 'wallet' | 'fund' | 'scope' | 'granted';

/** Native balance needed before a grant (KeyStore registration fee + margin). */
const MIN_NATIVE = 2_000_000_000_000_000; // 0.002, as a number of wei units

interface WizardAgent {
  chainId: number;
  tokenId: string;
  name: string;
  agentWallet: string | null;
}

type PasskeyWallet = Awaited<
  ReturnType<ReturnType<typeof altanaClient>['createPasskeyWallet']>
>;

export function SessionWizard({ agent }: { agent: WizardAgent }) {
  const [step, setStep] = useState<Step>('wallet');
  const [chainId, setChainId] = useState<number>(56);
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowlist, setAllowlist] = useState<string>(agent.agentWallet ?? '');
  const [cap, setCap] = useState<string>('25');
  const [hours, setHours] = useState<number>(24);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const publicClient = useCallback(
    () =>
      createPublicClient({
        chain: chainId === 97 ? bscTestnet : bsc,
        transport: http(),
      }),
    [chainId],
  );

  async function connectPasskey(mode: 'create' | 'recover') {
    setBusy(true);
    setError(null);
    try {
      const client = altanaClient();
      const w =
        mode === 'create'
          ? await client.createPasskeyWallet({ name: 'Agripinaa' })
          : await client.recoverFromPasskey();
      setWallet(w);
      setStep('fund');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (step !== 'fund' || !wallet) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const b = await publicClient().getBalance({
          address: wallet.address as `0x${string}`,
        });
        if (!cancelled) setBalance(b);
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

  async function grant() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const addresses = allowlist
        .split(/[\s,]+/)
        .map((a) => a.trim())
        .filter(Boolean);
      if (addresses.some((a) => !isAddress(a))) {
        throw new Error('Allowlist contains an invalid address.');
      }
      const scope = buildSessionScope({
        allowlist: addresses as `0x${string}`[],
        spendCap: { token: 'USDT', amount: cap, period: 'day' },
        expiresInSeconds: hours * 3600,
      });
      const client = altanaClient();
      const session = await client.grantSession({
        wallet,
        signer: wallet.signer,
        chainId,
        ...scope,
      });
      const summary = describeScope(scope);
      storeSession({
        session,
        chainId,
        agent: { chainId: agent.chainId, tokenId: agent.tokenId, name: agent.name },
        scope: {
          allowlist: addresses,
          capFormatted: summary.capFormatted,
          expiresAt: summary.expiresAt,
        },
      });
      setStep('granted');
      toast({ title: 'Session granted', detail: `${agent.name} is now active`, kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Grant failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const funded = balance != null && balance >= BigInt(MIN_NATIVE);
  const stepIndex = { wallet: 0, fund: 1, scope: 2, granted: 3 }[step];
  const primaryBtn =
    'rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)] disabled:opacity-50 disabled:shadow-none';

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-2xl border border-border bg-surface p-6">
        <Stepper current={stepIndex} />

        {step === 'wallet' && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Your agent wallet</h2>
              <p className="mt-1 text-sm text-muted">
                Sessions are granted from a smart account secured by a passkey
                (Face ID, fingerprint, or security key). No seed phrase, and the
                passkey never leaves your device.
              </p>
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-2">Network</p>
              <div className="inline-flex rounded-lg border border-border-strong p-0.5">
                {SUPPORTED_CHAINS.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setChainId(c.id)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      chainId === c.id
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-2 hover:text-foreground'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-3 pt-1">
              <button onClick={() => connectPasskey('create')} disabled={busy} className={primaryBtn}>
                {busy ? 'Waiting for passkey…' : 'Create with passkey'}
              </button>
              <button
                onClick={() => connectPasskey('recover')}
                disabled={busy}
                className="rounded-lg border border-border-strong px-4 py-2.5 text-sm transition-colors hover:border-primary/40 disabled:opacity-50"
              >
                I already have one
              </button>
            </div>
          </section>
        )}

        {step === 'fund' && wallet && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Gas for key registration</h2>
              <p className="mt-1 text-sm text-muted">
                Registering the session key on-chain costs a small native fee.
                Send at least 0.002 {chainId === 97 ? 'tBNB' : 'BNB'} to your
                account:
              </p>
            </div>
            <p className="break-all rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs">
              {wallet.address}
            </p>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm">
              <span className="text-muted-2">Balance</span>
              <span className={`tabular font-mono ${funded ? 'text-success' : 'text-muted'}`}>
                {balance == null
                  ? 'checking…'
                  : `${(Number(balance) / 1e18).toFixed(4)} ${chainId === 97 ? 'tBNB' : 'BNB'}`}
                {funded && ' ✓'}
              </span>
            </div>
            <button onClick={() => setStep('scope')} disabled={!funded} className={primaryBtn}>
              Continue
            </button>
          </section>
        )}

        {step === 'scope' && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">
                What may {agent.name} do?
              </h2>
              <p className="mt-1 text-sm text-muted">
                One signature grants exactly this authority, enforced by the
                account itself. Revoke any time.
              </p>
            </div>
            <label className="block text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-2">
                Contract allowlist
              </span>
              <span className="mb-1 block text-xs text-muted-2">
                The agent can call ONLY these contracts.
              </span>
              <textarea
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-border-strong bg-surface-2 p-2.5 font-mono text-xs focus:border-primary focus:outline-none"
                placeholder="0x…"
              />
            </label>
            <div className="flex flex-wrap gap-4">
              <label className="text-sm">
                <span className="mb-1 block text-xs uppercase tracking-wide text-muted-2">
                  Daily spend cap (USDT)
                </span>
                <input
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  className="tabular w-28 rounded-lg border border-border-strong bg-surface-2 p-2.5 font-mono text-sm focus:border-primary focus:outline-none"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs uppercase tracking-wide text-muted-2">
                  Expires after
                </span>
                <div className="inline-flex rounded-lg border border-border-strong p-0.5">
                  {[
                    { h: 1, label: '1h' },
                    { h: 24, label: '24h' },
                    { h: 168, label: '7d' },
                  ].map((o) => (
                    <button
                      key={o.h}
                      onClick={() => setHours(o.h)}
                      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                        hours === o.h ? 'bg-primary/15 text-primary' : 'text-muted-2 hover:text-foreground'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </label>
            </div>
            <button onClick={grant} disabled={busy} className={primaryBtn}>
              {busy ? 'Granting…' : 'Grant session · 1 signature'}
            </button>
          </section>
        )}

        {step === 'granted' && (
          <section className="mt-6 space-y-4">
            <div className="flex items-center gap-2">
              <VerifiedIcon className="h-6 w-6 text-success" />
              <h2 className="font-display text-lg font-semibold text-success">
                Session active
              </h2>
            </div>
            <p className="text-sm text-muted">
              {agent.name} now holds a scoped, revocable key. Manage or revoke it
              from your dashboard.
            </p>
            <a href="/dashboard" className={`inline-block ${primaryBtn}`}>
              Open dashboard
            </a>
          </section>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      <aside className="rounded-2xl border border-border bg-[linear-gradient(180deg,rgba(139,92,246,0.05),transparent_45%)] p-6">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-2">
          What you&apos;re granting
        </h3>
        <ul className="mt-4 space-y-4 text-sm">
          <Assurance icon={<ShieldIcon className="h-5 w-5" />} title="Scoped to an allowlist">
            The key can call only the contracts you list, nothing else on your
            account.
          </Assurance>
          <Assurance icon={<CoinsIcon className="h-5 w-5" />} title="Hard spend cap">
            A daily USDT ceiling the agent can never exceed, enforced on-chain.
          </Assurance>
          <Assurance icon={<LightningIcon className="h-5 w-5" />} title="Expires + revocable">
            It self-expires, and one passkey tap kills it early from your
            dashboard.
          </Assurance>
          <Assurance icon={<VerifiedIcon className="h-5 w-5" />} title="No seed phrase">
            A passkey secures the account; the private key never leaves your
            device.
          </Assurance>
        </ul>
      </aside>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  const steps = ['Wallet', 'Fund', 'Scope'];
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
            <span className={`text-sm ${active || done ? 'text-foreground' : 'text-muted-2'}`}>
              {label}
            </span>
            {i < steps.length - 1 && (
              <span className={`h-px flex-1 ${done ? 'bg-primary/50' : 'bg-border'}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Assurance({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
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
