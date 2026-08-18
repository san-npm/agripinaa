'use client';

import {
  buildSessionScope,
  describeScope,
} from '@agripinaa/session-kit';
import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, http, isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

import { altanaClient, SUPPORTED_CHAINS } from '@/lib/altana';
import { storeSession } from '@/lib/session-store';

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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const funded = balance != null && balance >= BigInt(MIN_NATIVE);

  return (
    <div className="max-w-xl space-y-6">
      {step === 'wallet' && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">1 · Your agent wallet</h2>
          <p className="text-sm text-muted">
            Sessions are granted from a smart account secured by a passkey
            (Face ID / fingerprint / security key). No seed phrase, and the
            passkey never leaves your device.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => connectPasskey('create')}
              disabled={busy}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
            >
              Create with passkey
            </button>
            <button
              onClick={() => connectPasskey('recover')}
              disabled={busy}
              className="rounded border border-border-strong px-4 py-2 text-sm disabled:opacity-50"
            >
              I already have one
            </button>
          </div>
          <label className="block text-sm text-muted">
            Network{' '}
            <select
              value={chainId}
              onChange={(e) => setChainId(Number(e.target.value))}
              className="ml-2 rounded border border-border-strong bg-surface px-2 py-1"
            >
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {step === 'fund' && wallet && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">2 · Gas for key registration</h2>
          <p className="text-sm text-muted">
            Registering the session key on-chain costs a small native fee. Send
            at least 0.002 {chainId === 97 ? 'tBNB' : 'BNB'} to your account:
          </p>
          <p className="break-all rounded border border-border-strong bg-surface p-3 font-mono text-xs">
            {wallet.address}
          </p>
          <p className="text-sm">
            Balance:{' '}
            <span className={funded ? 'text-success' : 'text-muted'}>
              {balance == null ? 'checking…' : `${Number(balance) / 1e18} ${chainId === 97 ? 'tBNB' : 'BNB'}`}
            </span>
            {funded && ' ✓'}
          </p>
          <button
            onClick={() => setStep('scope')}
            disabled={!funded}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            Continue
          </button>
        </section>
      )}

      {step === 'scope' && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">3 · What may {agent.name} do?</h2>
          <label className="block text-sm text-muted">
            Contract allowlist (comma-separated; the agent can call ONLY these)
            <textarea
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-border-strong bg-surface p-2 font-mono text-xs"
              placeholder="0x…"
            />
          </label>
          <div className="flex gap-4">
            <label className="text-sm text-muted">
              Daily spend cap (USDT)
              <input
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className="mt-1 block w-28 rounded border border-border-strong bg-surface p-2 text-sm"
              />
            </label>
            <label className="text-sm text-muted">
              Expires after
              <select
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="mt-1 block rounded border border-border-strong bg-surface p-2 text-sm"
              >
                <option value={1}>1 hour</option>
                <option value={24}>24 hours</option>
                <option value={168}>7 days</option>
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-2">
            One signature grants exactly this authority; you can revoke it at
            any time from your dashboard.
          </p>
          <button
            onClick={grant}
            disabled={busy}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {busy ? 'Granting…' : 'Grant session'}
          </button>
        </section>
      )}

      {step === 'granted' && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium text-success">
            Session active
          </h2>
          <p className="text-sm text-muted">
            {agent.name} now holds a scoped, revocable key. Manage or revoke it
            from your dashboard.
          </p>
          <a
            href="/dashboard"
            className="inline-block rounded bg-primary px-4 py-2 text-sm font-medium text-on-primary"
          >
            Open dashboard
          </a>
        </section>
      )}

      {error && (
        <p className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
