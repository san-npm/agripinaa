'use client';

import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import { useCallback, useEffect, useState } from 'react';

import { altanaClient } from '@/lib/altana';
import { readManagedPosition, withdrawToIdle, type ManagedPosition } from '@/lib/managed';
import { forgetSession, markRevoked, reviveSession, type StoredSessionMeta } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { CoinsIcon } from './icons';

type Validity = 'checking' | 'valid' | 'invalid' | 'unknown';

const VENUE_LABEL: Record<ManagedPosition['venue'], string> = {
  idle: 'Idle (not deployed)',
  venus: 'Venus',
  aave: 'Aave V3',
};

export function ManagedPositionCard({
  meta,
  onChange,
}: {
  meta: StoredSessionMeta;
  onChange: () => void;
}) {
  const [pos, setPos] = useState<ManagedPosition | null>(null);
  const [validity, setValidity] = useState<Validity>('checking');
  const [busy, setBusy] = useState<null | 'withdraw' | 'revoke'>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshPosition = useCallback(async () => {
    try {
      const p = await readManagedPosition(meta.account as `0x${string}`, meta.chainId);
      setPos(p);
    } catch {
      /* transient RPC error; leave the last-known position */
    }
  }, [meta.account, meta.chainId]);

  useEffect(() => {
    let cancelled = false;
    void refreshPosition();
    (async () => {
      if (!meta.publicKey || meta.account === 'unknown') {
        setValidity('unknown');
        return;
      }
      try {
        const valid = await isSessionKeyValid({
          chainId: meta.chainId,
          account: meta.account as `0x${string}`,
          sessionPublicKey: meta.publicKey as `0x${string}`,
        });
        if (!cancelled) setValidity(valid ? 'valid' : 'invalid');
      } catch {
        if (!cancelled) setValidity('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meta, refreshPosition]);

  async function reauth() {
    const client = altanaClient();
    const wallet = await client.recoverFromPasskey();
    if (wallet.address.toLowerCase() !== meta.account.toLowerCase()) {
      throw new Error('This passkey controls a different account than this position.');
    }
    return wallet;
  }

  async function withdraw() {
    setBusy('withdraw');
    setError(null);
    try {
      const wallet = await reauth();
      await withdrawToIdle(wallet as never, meta.chainId);
      await refreshPosition();
      toast({ title: 'Unwound to USDT', detail: 'Funds are idle in your account', kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Withdraw failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy('revoke');
    setError(null);
    try {
      const wallet = await reauth();
      const session = reviveSession(meta);
      await altanaClient().revokeSession({
        wallet,
        signer: wallet.signer,
        chainId: meta.chainId,
        session: session as Parameters<ReturnType<typeof altanaClient>['revokeSession']>[0]['session'],
      });
      markRevoked(meta.id);
      setValidity('invalid');
      onChange();
      toast({ title: 'Agent stopped', detail: 'Session revoked', kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Revoke failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const active = validity === 'valid';
  const venueBadge =
    pos?.venue === 'idle'
      ? 'bg-surface-2 text-muted'
      : 'bg-success/15 text-success';

  return (
    <li className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
            <CoinsIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="font-medium">{meta.agent.name}</p>
            <p className="text-xs text-muted-2">
              {meta.chainId === 97 ? 'BSC Testnet' : 'BNB Chain'} · managed yield
            </p>
          </div>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${active ? 'bg-success/15 text-success' : 'bg-surface-2 text-muted'}`}>
          {validity === 'checking' ? 'checking…' : active ? 'managing' : 'stopped'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1.2fr_1fr]">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-2">Under management</p>
          <p className="tabular mt-1 font-mono text-xl font-semibold">
            {pos ? `${Number(pos.totalUsdt).toFixed(2)} USDT` : '…'}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-2">Current venue</p>
          <span className={`tabular mt-1 inline-block rounded px-2 py-0.5 text-sm ${venueBadge}`}>
            {pos ? VENUE_LABEL[pos.venue] : '…'}
          </span>
        </div>
      </div>

      {pos && (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
          <div><dt className="inline text-muted-2">Idle: </dt><dd className="inline tabular font-mono">{Number(pos.idleUsdt).toFixed(2)}</dd></div>
          <div><dt className="inline text-muted-2">Aave: </dt><dd className="inline tabular font-mono">{Number(pos.aaveUsdt).toFixed(2)}</dd></div>
          <div><dt className="inline text-muted-2">Venus: </dt><dd className="inline tabular font-mono">{Number(pos.venusUsdt).toFixed(2)}</dd></div>
        </dl>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={withdraw}
          disabled={busy !== null}
          className="rounded border border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
        >
          {busy === 'withdraw' ? 'Unwinding…' : 'Withdraw to USDT'}
        </button>
        {active && (
          <button
            onClick={revoke}
            disabled={busy !== null}
            className="rounded border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {busy === 'revoke' ? 'Stopping…' : 'Stop agent'}
          </button>
        )}
        <button
          onClick={() => {
            forgetSession(meta.id);
            onChange();
          }}
          disabled={busy !== null}
          className="rounded border border-border-strong px-3 py-1.5 text-xs text-muted hover:border-border-strong disabled:opacity-50"
        >
          Forget
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-2">
        Withdraw unwinds everything to plain USDT in your account (funds stay
        yours the whole time). Stop revokes the agent&apos;s key.
      </p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}
