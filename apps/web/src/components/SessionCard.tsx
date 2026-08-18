'use client';

import { isSessionKeyValid } from '@agripinaa/session-kit';
import { useEffect, useState } from 'react';

import { altanaClient } from '@/lib/altana';
import {
  forgetSession,
  markRevoked,
  reviveSession,
  type StoredSessionMeta,
} from '@/lib/session-store';

type Validity = 'checking' | 'valid' | 'invalid' | 'unknown';

export function SessionCard({
  meta,
  onChange,
}: {
  meta: StoredSessionMeta;
  onChange: () => void;
}) {
  const [validity, setValidity] = useState<Validity>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
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
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [meta]);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const client = altanaClient();
      // Re-authenticate with the passkey to sign the revocation as admin.
      const wallet = await client.recoverFromPasskey();
      if (wallet.address.toLowerCase() !== meta.account.toLowerCase()) {
        throw new Error(
          'This passkey controls a different account than the session grantor.',
        );
      }
      const session = reviveSession(meta);
      await client.revokeSession({
        wallet,
        signer: wallet.signer,
        chainId: meta.chainId,
        session: session as Parameters<typeof client.revokeSession>[0]['session'],
      });
      markRevoked(meta.id);
      setValidity('invalid');
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const badge =
    validity === 'valid'
      ? { text: 'active on-chain', cls: 'bg-emerald-900/60 text-emerald-300' }
      : validity === 'invalid'
        ? { text: 'revoked / expired', cls: 'bg-zinc-800 text-zinc-400' }
        : validity === 'checking'
          ? { text: 'checking…', cls: 'bg-zinc-800 text-zinc-500' }
          : { text: 'not verifiable', cls: 'bg-amber-900/40 text-amber-300' };

  return (
    <li className="rounded-lg border border-zinc-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{meta.agent.name}</p>
          <p className="text-xs text-zinc-500">
            {meta.chainId === 97 ? 'BSC Testnet' : 'BNB Chain'} · granted{' '}
            {new Date(meta.grantedAt).toLocaleString()}
          </p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${badge.cls}`}>
          {badge.text}
        </span>
      </div>
      <dl className="mt-3 space-y-1 text-xs text-zinc-400">
        <div>
          <dt className="inline text-zinc-500">Cap: </dt>
          <dd className="inline">{meta.scope.capFormatted}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-500">Expires: </dt>
          <dd className="inline">{new Date(meta.scope.expiresAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="inline text-zinc-500">Allowlist: </dt>
          <dd className="inline break-all font-mono">
            {meta.scope.allowlist.join(', ')}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex gap-2">
        {validity === 'valid' && (
          <button
            onClick={revoke}
            disabled={busy}
            className="rounded border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
          >
            {busy ? 'Revoking…' : 'Revoke'}
          </button>
        )}
        <button
          onClick={() => {
            forgetSession(meta.id);
            onChange();
          }}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:border-zinc-500"
        >
          Forget
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
    </li>
  );
}
