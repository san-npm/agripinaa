'use client';

import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import { MANAGED_TOKENS, routerByAddress, routerFor } from '@agripinaa/shared/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';

import { altanaClient } from '@/lib/altana';
import {
  destinationProblem,
  readManagedPosition,
  readRotationHistory,
  readVenueApys,
  rotationRationale,
  sendNativeOut,
  sendTokenOut,
  withdrawToIdle,
  WITHDRAW_GAS_RESERVE_WEI,
  type ManagedPosition,
  type RotationEvent,
  type VenueApys,
} from '@/lib/managed';
import { forgetSession, markRevoked, reviveSession, type StoredSessionMeta } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { TokenLogo } from './icons';

type Validity = 'checking' | 'valid' | 'invalid' | 'unknown';
type Busy = null | 'unwind' | 'usdt' | 'bnb' | 'revoke';

const VENUE_LABEL: Record<ManagedPosition['venue'], string> = {
  idle: 'Idle (not deployed)',
  venus: 'Venus',
  aave: 'Aave V3',
};

/** Below this, a USDT balance is rounding dust, not a real position. */
const USDT_DUST_WEI = 10n ** 16n; // 0.01 USDT

function relTime(ms: number | null): string {
  if (ms == null) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function explorerTx(chainId: number, tx: string): string {
  return `${chainId === 97 ? 'https://testnet.bscscan.com' : 'https://bscscan.com'}/tx/${tx}`;
}

export function ManagedPositionCard({
  meta,
  onChange,
}: {
  meta: StoredSessionMeta;
  onChange: () => void;
}) {
  const [pos, setPos] = useState<ManagedPosition | null>(null);
  const [apys, setApys] = useState<VenueApys | null>(null);
  const [history, setHistory] = useState<RotationEvent[] | null>(null);
  const [validity, setValidity] = useState<Validity>('checking');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [dest, setDest] = useState<string>('');

  // Which stablecoin this position manages, derived from the UNIQUE known router
  // in the session's allowlist on this chain, not just allowlist[0], so a
  // stale/extra entry can't silently mis-derive the token (e.g. render a USDC
  // position as USDT). If it doesn't resolve to exactly one known router, the
  // record is malformed and every managed action is disabled below.
  const knownRouters = (meta.scope.allowlist ?? [])
    .map((a) => routerByAddress(a))
    .filter((r): r is NonNullable<typeof r> => !!r && r.chainId === meta.chainId);
  const configValid = knownRouters.length === 1;
  const token = configValid ? knownRouters[0]!.symbol : 'USDT';

  const refreshPosition = useCallback(async () => {
    try {
      const p = await readManagedPosition(meta.account as `0x${string}`, meta.chainId, token);
      setPos(p);
    } catch {
      /* transient RPC error; leave the last-known position */
    }
  }, [meta.account, meta.chainId, token]);

  useEffect(() => {
    let cancelled = false;
    readVenueApys(meta.chainId, token)
      .then((a) => !cancelled && setApys(a))
      .catch(() => {});
    if (meta.account !== 'unknown') {
      readRotationHistory(meta.account as Hex, meta.chainId, token)
        .then((h) => !cancelled && setHistory(h))
        .catch(() => !cancelled && setHistory([]));
    }
    return () => {
      cancelled = true;
    };
  }, [meta.chainId, meta.account, token]);

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

  const destProblem = dest ? destinationProblem(dest, meta.account, meta.chainId) : null;
  const destValid = dest !== '' && destProblem === null;
  const hasUsdt = pos != null && pos.idleWei + pos.deployedWei > USDT_DUST_WEI;

  // Revoke the agent's session, marking it revoked ONLY if the bundle
  // confirmed on-chain (a FAILED/PENDING revoke must not read as "stopped").
  async function doRevoke(wallet: Awaited<ReturnType<typeof reauth>>) {
    const session = reviveSession(meta);
    const r = await altanaClient().revokeSession({
      wallet,
      signer: wallet.signer,
      chainId: meta.chainId,
      session: session as Parameters<ReturnType<typeof altanaClient>['revokeSession']>[0]['session'],
    });
    if (r.status !== 'CONFIRMED') {
      throw new Error(
        r.status === 'PENDING'
          ? 'Stopping the agent is still pending on-chain. Retry shortly.'
          : 'Stopping the agent did not go through (reverted on-chain).',
      );
    }
    markRevoked(meta.id);
    setValidity('invalid');
  }

  // Full exit to an external wallet: stop the agent first (so it can't
  // re-deploy mid-withdrawal), unwind any venue position, then send all USDT.
  async function withdrawUsdtOut() {
    if (!destValid) {
      setError(destProblem ?? 'Enter a valid destination address.');
      return;
    }
    setBusy('usdt');
    setError(null);
    try {
      const wallet = await reauth();
      if (validity === 'valid') await doRevoke(wallet);
      const cur = await readManagedPosition(meta.account as Hex, meta.chainId, token);
      if (cur.deployedWei > 0n) {
        await withdrawToIdle(wallet as never, meta.chainId, token);
      }
      const fresh = await readManagedPosition(meta.account as Hex, meta.chainId, token);
      if (fresh.idleWei <= 0n) throw new Error(`No ${token} available to withdraw.`);
      const router = routerFor(meta.chainId, token);
      if (!router) throw new Error('No router on this chain.');
      await sendTokenOut(wallet as never, meta.chainId, router.usdt, dest as Hex, fresh.idleWei, token);
      await refreshPosition();
      onChange();
      toast({ title: `${token} withdrawn`, detail: `Sent to ${dest.slice(0, 10)}…`, kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Withdraw failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  // Sweep BNB to an external wallet, keeping a reserve so this tx can pay its
  // own gas. Blocked while USDT remains, so gas is never stranded under funds.
  async function withdrawBnbOut() {
    if (!destValid) {
      setError(destProblem ?? 'Enter a valid destination address.');
      return;
    }
    setBusy('bnb');
    setError(null);
    try {
      const wallet = await reauth();
      // Don't strand gas under ANY still-deployed stablecoin on this account,
      // not just this card's token: if a USDC position is still live, sweeping
      // BNB now could leave its exit unable to pay gas. The BNB balance is the
      // account's, identical whichever token we read it through.
      let nativeWei = 0n;
      for (const sym of MANAGED_TOKENS) {
        const p = await readManagedPosition(meta.account as Hex, meta.chainId, sym);
        if (p.idleWei + p.deployedWei > USDT_DUST_WEI) {
          throw new Error(`Withdraw your ${sym} first: sweeping BNB now could leave too little gas to move it.`);
        }
        nativeWei = p.nativeWei;
      }
      const amount = nativeWei - WITHDRAW_GAS_RESERVE_WEI;
      if (amount <= 0n) throw new Error('Not enough BNB to withdraw after keeping a gas reserve.');
      await sendNativeOut(wallet as never, meta.chainId, dest as Hex, amount, token);
      await refreshPosition();
      toast({ title: 'BNB withdrawn', detail: `Sent to ${dest.slice(0, 10)}…`, kind: 'success' });
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
      await doRevoke(wallet);
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

  // Live yield facts for the dashboard.
  const rationale = pos && apys ? rotationRationale(pos.venue, apys) : null;
  const currentApyPct = rationale?.currentApyBps != null ? rationale.currentApyBps / 100 : null;
  const principal = meta.principalUsdt != null ? Number(meta.principalUsdt) : null;
  const positionValue = pos ? Number(pos.totalUsdt) : null;
  const deployed = pos ? pos.venue !== 'idle' : false;
  // Interest only accrues, so clamp tiny negative rounding to zero.
  const earned =
    principal != null && positionValue != null ? Math.max(0, positionValue - principal) : null;
  const fmtEarned = (n: number) => (n >= 0.01 ? n.toFixed(2) : n.toFixed(6));

  return (
    <li className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5">
            <TokenLogo symbol={token} className="h-7 w-7" />
          </span>
          <div>
            <p className="font-medium">{meta.agent.name}</p>
            <p className="text-xs text-muted-2">
              {meta.chainId === 97 ? 'BSC Testnet' : 'BNB Chain'} · managed {token} yield
            </p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs ${active ? 'bg-success/15 text-success' : 'bg-surface-2 text-muted'}`}>
          {active && <span className="live-dot h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
          {validity === 'checking' ? 'checking…' : active ? 'managing' : 'stopped'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1.2fr_1fr]">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-2">Under management</p>
          <p className="tabular mt-1 font-mono text-xl font-semibold">
            {pos ? `${Number(pos.totalUsdt).toFixed(2)} ${token}` : '…'}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-2">Current venue</p>
          <div className="mt-1 flex items-center gap-2">
            <span className={`tabular inline-block rounded px-2 py-0.5 text-sm ${venueBadge}`}>
              {pos ? VENUE_LABEL[pos.venue] : '…'}
            </span>
            {deployed && currentApyPct != null && (
              <span className="tabular font-mono text-sm text-success">
                ~{currentApyPct.toFixed(2)}% APY
              </span>
            )}
          </div>
        </div>
      </div>

      {pos && (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
          <div><dt className="inline text-muted-2">Idle: </dt><dd className="inline tabular font-mono">{Number(pos.idleUsdt).toFixed(2)}</dd></div>
          <div><dt className="inline text-muted-2">Aave: </dt><dd className="inline tabular font-mono">{Number(pos.aaveUsdt).toFixed(2)}</dd></div>
          <div><dt className="inline text-muted-2">Venus: </dt><dd className="inline tabular font-mono">{Number(pos.venusUsdt).toFixed(2)}</dd></div>
        </dl>
      )}

      {/* Live yield: what it earns, what it has earned, and why it sits where it does. */}
      {(earned != null || rationale) && (
        <div className={`mt-3 rounded-lg border border-border bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent)] p-3 ${active ? 'agp-working' : ''}`}>
          {active && (
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-success">
              <span className="agp-think-dots inline-flex items-center gap-[3px]" aria-hidden>
                <i /><i /><i />
              </span>
              Agent is optimizing your yield
            </p>
          )}
          {earned != null && deployed && (
            <p className="text-sm">
              <span className="text-muted-2">Earned so far </span>
              <span className="tabular font-mono font-semibold text-success">+{fmtEarned(earned)} {token}</span>
              {principal != null && (
                <span className="text-xs text-muted-2"> on {principal.toFixed(2)} deposited</span>
              )}
            </p>
          )}
          {rationale && apys && (
            <p className="mt-1 text-xs leading-relaxed text-muted-2">
              Venus {(apys.venusApyBps / 100).toFixed(2)}% vs Aave {(apys.aaveApyBps / 100).toFixed(2)}%.{' '}
              {pos && pos.venue === 'idle'
                ? 'Awaiting the agent’s next sweep to deploy into the higher one.'
                : `Holding the higher one; the agent rotates to ${rationale.otherName} only if it leads by ${(rationale.hysteresisBps / 100).toFixed(2)}% on two checks (currently ${rationale.edgeBps >= 0 ? '+' : ''}${(rationale.edgeBps / 100).toFixed(2)}%).`}
            </p>
          )}
        </div>
      )}

      {history && history.length > 0 && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-muted-2">Agent activity</p>
          <ul className="mt-2 space-y-1.5">
            {history.slice(0, 6).map((e) => (
              <li key={e.txHash} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                  <span className="text-foreground">{e.label}</span>
                  <span className="tabular font-mono text-muted-2">{Number(e.amountUsdt).toFixed(2)} {token}</span>
                </span>
                <span className="flex items-center gap-2 text-muted-2">
                  <span>{relTime(e.timestamp)}</span>
                  <a
                    href={explorerTx(meta.chainId, e.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    tx ↗
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3">
        <p className="text-xs uppercase tracking-wide text-muted-2">Withdraw to your wallet</p>
        {!configValid && (
          <p className="mt-2 text-xs text-danger">
            This saved record doesn&apos;t map to a single known router on this network, so its
            managed actions are disabled. Use &ldquo;Forget&rdquo; and re-activate from the agent page.
          </p>
        )}
        <input
          value={dest}
          onChange={(e) => setDest(e.target.value.trim())}
          spellCheck={false}
          placeholder="0x… destination address"
          className={`mt-2 w-full rounded-lg border bg-surface p-2.5 font-mono text-xs focus:outline-none ${
            dest && destProblem ? 'border-danger focus:border-danger' : 'border-border-strong focus:border-primary'
          }`}
        />
        {dest && destProblem && <p className="mt-1 text-xs text-danger">{destProblem}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={withdrawUsdtOut}
            disabled={!configValid || busy !== null || !destValid || (pos != null && pos.idleWei === 0n && pos.deployedWei === 0n)}
            className="rounded border border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {busy === 'usdt' ? 'Withdrawing…' : `Withdraw ${token}${pos ? ` (${Number(pos.totalUsdt).toFixed(2)})` : ''}`}
          </button>
          <button
            onClick={withdrawBnbOut}
            disabled={!configValid || busy !== null || !destValid || hasUsdt || (pos != null && pos.nativeWei <= WITHDRAW_GAS_RESERVE_WEI)}
            title={hasUsdt ? `Withdraw your ${token} first` : undefined}
            className="rounded border border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {busy === 'bnb' ? 'Withdrawing…' : `Withdraw BNB${pos ? ` (${Number(pos.nativeBnb).toFixed(4)})` : ''}`}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-2">
          Withdraw {token} stops the agent, unwinds any venue position, then sends
          everything to your address. Withdraw BNB (available once {token} is out)
          keeps a small reserve so the transaction can pay its own gas.
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
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
        Funds stay in your account the whole time. Stop revokes the agent&apos;s
        key; your funds remain and can still be withdrawn above.
      </p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}
