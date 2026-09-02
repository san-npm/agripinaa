'use client';

import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import { MANAGED_NATIVE_CAP } from '@agripinaa/session-kit/scope';
import { managedStrategyFor } from '@agripinaa/shared/managed-strategies';
import { useEffect, useState, type ReactNode } from 'react';

import { altanaClient } from '@/lib/altana';
import { clearFundingCheckpointForSession } from '@/lib/funding-checkpoint';
import { registerManaged } from '@/lib/managed';
import { readableManagedCeilings, readableSessionCeiling } from '@/lib/session-copy';
import {
  forgetSession,
  markRegistered,
  markRevoked,
  reviveSession,
  type StoredSessionMeta,
} from '@/lib/session-store';
import { toast } from '@/lib/toast';

export type SessionValidity = 'checking' | 'valid' | 'invalid' | 'unknown';

export function SessionCard({
  meta,
  onChange,
  position,
  forgetDisabled = false,
  forgetDisabledReason,
}: {
  meta: StoredSessionMeta;
  onChange: () => void;
  position?: ReactNode | ((validity: SessionValidity) => ReactNode);
  forgetDisabled?: boolean;
  forgetDisabledReason?: string;
}) {
  const [validity, setValidity] = useState<SessionValidity>('checking');
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
      const result = await client.revokeSession({
        wallet,
        signer: wallet.signer,
        chainId: meta.chainId,
        session: session as Parameters<typeof client.revokeSession>[0]['session'],
      });
      if (result.status !== 'CONFIRMED') {
        throw new Error(
          result.status === 'PENDING'
            ? 'Stopping the agent is still pending on-chain. Retry shortly.'
            : 'Stopping the agent did not go through (reverted on-chain).',
        );
      }
      markRevoked(meta.id);
      setValidity('invalid');
      onChange();
      toast({ title: 'Session revoked', detail: meta.agent.name, kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Revoke failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function finishHandoff() {
    const slug = meta.agent.slug;
    const strategy = slug ? managedStrategyFor(slug) : undefined;
    if (!slug || !strategy) return;

    setBusy(true);
    setError(null);
    try {
      const client = altanaClient();
      const wallet = await client.recoverFromPasskey();
      if (wallet.address.toLowerCase() !== meta.account.toLowerCase()) {
        throw new Error('This passkey controls a different account than the saved session.');
      }
      const session = reviveSession(meta);
      for (const checker of strategy.signatureCheckers) {
        const approved = await client.approveSignatureChecker({
          wallet,
          signer: wallet.signer,
          session: session as Parameters<typeof client.approveSignatureChecker>[0]['session'],
          checker,
          chainId: meta.chainId,
        });
        if (approved.status !== 'CONFIRMED') {
          throw new Error('The strategy signature-checker approval did not confirm.');
        }
      }
      await registerManaged(slug, {
        account: meta.account as `0x${string}`,
        chainId: meta.chainId,
        session,
      });
      markRegistered(meta.id);
      clearFundingCheckpointForSession(
        meta.chainId,
        meta.account as `0x${string}`,
        slug,
        meta.correlatedAt ?? meta.grantedAt,
      );
      onChange();
      toast({
        title: `${meta.agent.name} activated`,
        detail: 'The runner accepted the saved session; no new key was granted.',
        kind: 'success',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast({ title: 'Handoff failed', detail: message.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const badge =
    validity === 'valid'
      ? { text: 'active on-chain', cls: 'bg-success/15 text-success' }
      : validity === 'invalid'
        ? { text: 'revoked / expired', cls: 'bg-surface-2 text-muted' }
        : validity === 'checking'
          ? { text: 'checking…', cls: 'bg-surface-2 text-muted-2' }
          : { text: 'not verifiable', cls: 'bg-primary/15 text-primary' };
  const strategy = managedStrategyFor(meta.agent.slug ?? '');

  return (
    <li id={`session-${meta.id}`} className="scroll-mt-24 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{meta.agent.name}</p>
          <p className="text-xs text-muted-2">
            {meta.chainId === 97 ? 'BSC Testnet' : 'BNB Chain'} · granted{' '}
            {new Date(meta.grantedAt).toLocaleString()}
          </p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${badge.cls}`}>
          {badge.text}
        </span>
      </div>
      {typeof position === 'function' ? position(validity) : position}
      <details className="mt-4 rounded-lg border border-border bg-surface-2 p-3 text-xs">
        <summary className="cursor-pointer select-none font-medium text-foreground">
          Session permissions
        </summary>
        <dl className="mt-3 space-y-2 text-muted">
          {strategy && (
            <>
              <div>
                <dt className="text-muted-2">What the agent can do</dt>
                <dd className="mt-0.5 leading-relaxed">{strategy.summary}</dd>
              </div>
              <div>
                <dt className="text-muted-2">On-chain authorization ceilings</dt>
                <dd className="mt-1 leading-relaxed">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {readableManagedCeilings(
                      meta.scope.capFormatted,
                      strategy.additionalSpendCaps,
                      MANAGED_NATIVE_CAP,
                    ).map((ceiling) => <li key={ceiling}>{ceiling}</li>)}
                  </ul>
                  <p className="mt-2">
                    These are hard daily maximums, not your balance, fees, or the agent&apos;s
                    intended spend.
                  </p>
                  {strategy.signatureCheckers.length > 0 && (
                    <p className="mt-1">Separately, Ophis order authority is bounded by the assets approved in this dedicated account.</p>
                  )}
                </dd>
              </div>
            </>
          )}
          {!strategy && (
            <div>
              <dt className="text-muted-2">Daily spend limit</dt>
              <dd className="mt-0.5">{readableSessionCeiling(meta.scope.capFormatted)}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted-2">Expires</dt>
            <dd className="mt-0.5">{new Date(meta.scope.expiresAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-2">Allowed contract{meta.scope.allowlist.length === 1 ? '' : 's'}</dt>
            <dd className="mt-0.5 break-all font-mono">
              {meta.scope.allowlist.join(', ')}
            </dd>
          </div>
        </dl>
      </details>
      <div className="mt-3 flex gap-2">
        {meta.registrationStatus === 'pending'
          && managedStrategyFor(meta.agent.slug ?? '')
          && validity !== 'invalid' && (
          <button
            onClick={finishHandoff}
            disabled={busy}
            className="rounded border border-primary/40 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {busy ? 'Finishing…' : 'Finish activation'}
          </button>
        )}
        {validity === 'valid' && (
          <button
            onClick={revoke}
            disabled={busy}
            className="rounded border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {busy ? 'Revoking…' : 'Revoke'}
          </button>
        )}
        <button
          onClick={() => {
            forgetSession(meta.id);
            onChange();
          }}
          disabled={busy || validity !== 'invalid' || forgetDisabled}
          title={
            validity !== 'invalid'
              ? 'Confirm the session is stopped on-chain before forgetting it'
              : forgetDisabled
                ? forgetDisabledReason
                : undefined
          }
          className="rounded border border-border-strong px-3 py-1 text-xs text-muted hover:border-border-strong disabled:opacity-50"
        >
          Forget
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}
