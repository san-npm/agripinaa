'use client';

import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import {
  isDebtCompleteRouter,
  isRetiredRouterAddress,
  MANAGED_TOKENS,
  recoveryRouterFromAllowlist,
  routerFor,
} from '@agripinaa/shared/contracts';
import { useEffect, useState } from 'react';
import type { Hex } from 'viem';

import { altanaClient } from '@/lib/altana';
import { clearFundingCheckpointForSession } from '@/lib/funding-checkpoint';
import { managedServiceStatus, readManagedRunnerStatus, type ManagedRunnerStatus } from '@/lib/managed-router';
import {
  destinationProblem,
  managedPolicyDisplay,
  readManagedPosition,
  readRotationHistory,
  readVenueApys,
  registerManaged,
  rotationRationale,
  sendNativeOut,
  sendTokenOut,
  shouldOfferManagedHandoffRetry,
  withdrawToIdle,
  WITHDRAW_GAS_RESERVE_WEI,
  type ManagedPosition,
  type RotationHistory,
  type VenueApys,
} from '@/lib/managed';
import { forgetSession, markRegistered, markRevoked, reviveSession, type StoredSessionMeta } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { TokenLogo } from './icons';

type Validity = 'checking' | 'valid' | 'invalid' | 'unknown';
type Busy = null | 'unwind' | 'usdt' | 'bnb' | 'revoke' | 'register';

const VENUE_LABEL: Record<ManagedPosition['venue'], string> = {
  idle: 'Idle (not deployed)',
  venus: 'Venus',
  aave: 'Aave V3',
  split: 'Split · attention needed',
};

/** Below this, a USDT balance is rounding dust, not an actual position. */
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
  const [history, setHistory] = useState<RotationHistory | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [validity, setValidity] = useState<Validity>('checking');
  const [runnerStatus, setRunnerStatus] = useState<ManagedRunnerStatus>('checking');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [dest, setDest] = useState<string>('');

  // Resolve the UNIQUE router saved in this session, including superseded
  // recovery-only deployments. Activation and the runner deliberately use a
  // different active-only lookup; this path exists solely so an owner can
  // unwind through the exact immutable contract the account already approved.
  const scopedRouter = recoveryRouterFromAllowlist(meta.scope.allowlist ?? [], meta.chainId);
  const scopedRouterAddress = scopedRouter?.address;
  const configValid = scopedRouter !== undefined;
  const token = scopedRouter?.symbol ?? 'USDT';
  const recoveryOnly = scopedRouter
    ? isRetiredRouterAddress(scopedRouter.address) || !isDebtCompleteRouter(scopedRouter)
    : false;
  const safeRecoveryRouter = routerFor(meta.chainId, token);
  const canRecoverDeployed = isDebtCompleteRouter(safeRecoveryRouter);
  const destinationInputId = `withdraw-destination-${meta.id}`;

  async function refreshPosition() {
    if (!scopedRouterAddress) return;
    try {
      const p = await readManagedPosition(
        meta.account as `0x${string}`,
        meta.chainId,
        token,
        scopedRouterAddress,
      );
      setPos(p);
    } catch {
      /* transient RPC error; leave the last-known position */
    }
  }

  useEffect(() => {
    if (!scopedRouterAddress) return;
    let cancelled = false;
    readVenueApys(meta.chainId, token, scopedRouterAddress)
      .then((a) => !cancelled && setApys(a))
      .catch(() => {});
    if (meta.account !== 'unknown') {
      readRotationHistory(meta.account as Hex, meta.chainId, token, scopedRouterAddress)
        .then((h) => {
          if (!cancelled) {
            setHistory(h);
            setHistoryUnavailable(false);
          }
        })
        .catch(() => {
          if (!cancelled) setHistoryUnavailable(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [meta.chainId, meta.account, scopedRouterAddress, token]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (scopedRouterAddress) {
        void readManagedPosition(meta.account as `0x${string}`, meta.chainId, token, scopedRouterAddress)
          .then((p) => !cancelled && setPos(p))
          .catch(() => {});
      }
      void (async () => {
        if (!meta.publicKey || meta.account === 'unknown') {
          if (!cancelled) setValidity('unknown');
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
      void readManagedRunnerStatus(meta.agent.slug, meta.account, scopedRouterAddress ?? '')
        .then((status) => !cancelled && setRunnerStatus(status));
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [meta.account, meta.agent.slug, meta.chainId, meta.publicKey, scopedRouterAddress, token]);

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

  /** Recovery must prove the scoped key is stopped now, not trust stale UI state. */
  async function ensureSessionStopped(wallet: Awaited<ReturnType<typeof reauth>>) {
    if (!meta.publicKey || meta.account === 'unknown') {
      throw new Error('Cannot verify this session on-chain; recovery is disabled.');
    }
    let live: boolean;
    try {
      live = await isSessionKeyValid({
        chainId: meta.chainId,
        account: meta.account as Hex,
        sessionPublicKey: meta.publicKey as Hex,
      });
    } catch {
      throw new Error('Could not verify that the agent is stopped. Retry when the chain RPC is available.');
    }
    if (live) {
      await doRevoke(wallet);
    } else {
      markRevoked(meta.id);
      setValidity('invalid');
    }
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
      if (!scopedRouter) throw new Error('This saved session has no recognized recovery router.');
      const wallet = await reauth();
      await ensureSessionStopped(wallet);
      const cur = await readManagedPosition(meta.account as Hex, meta.chainId, token, scopedRouter.address);
      if (cur.deployedWei > 0n) {
        if (canRecoverDeployed) {
          await withdrawToIdle(wallet as never, meta.chainId, token);
        } else if (cur.idleWei <= 0n) {
          throw new Error(
            `The deployed ${token} position cannot be automated safely until the debt-complete replacement router is live. No funds were moved.`,
          );
        }
      }
      const fresh = await readManagedPosition(meta.account as Hex, meta.chainId, token, scopedRouter.address);
      if (fresh.idleWei <= 0n) throw new Error(`No ${token} available to withdraw.`);
      const partial = fresh.deployedWei > USDT_DUST_WEI;
      await sendTokenOut(wallet as never, meta.chainId, scopedRouter.usdt, dest as Hex, fresh.idleWei, token);
      await refreshPosition();
      onChange();
      toast({
        title: partial ? `Partial ${token} withdrawal` : `${token} withdrawn`,
        detail: partial
          ? canRecoverDeployed
            ? `${(Number(fresh.aaveUsdt) + Number(fresh.venusUsdt)).toFixed(4)} ${token} remains as debt-protected collateral in your account.`
            : `${(Number(fresh.aaveUsdt) + Number(fresh.venusUsdt)).toFixed(4)} ${token} remains deployed until the debt-complete replacement router is live.`
          : `Sent to ${dest.slice(0, 10)}…`,
        kind: 'success',
      });
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
      if (!scopedRouter) throw new Error('This saved session has no recognized recovery router.');
      const wallet = await reauth();
      await ensureSessionStopped(wallet);
      // Don't strand gas under ANY still-deployed stablecoin on this account,
      // not just this card's token: if a USDC position is still live, sweeping
      // BNB now could leave its exit unable to pay gas. The BNB balance is the
      // account's, identical whichever token we read it through.
      let nativeWei = 0n;
      for (const sym of MANAGED_TOKENS) {
        const address = sym === token ? scopedRouter.address : undefined;
        const p = await readManagedPosition(meta.account as Hex, meta.chainId, sym, address);
        if (p.idleWei + p.deployedWei > USDT_DUST_WEI) {
          throw new Error(`Withdraw your ${sym} first: sweeping BNB now could leave too little gas to move it.`);
        }
        nativeWei = p.nativeWei;
      }
      const amount = nativeWei - WITHDRAW_GAS_RESERVE_WEI;
      if (amount <= 0n) throw new Error('Not enough BNB to withdraw after keeping a gas reserve.');
      await sendNativeOut(wallet as never, meta.chainId, dest as Hex, amount);
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

  async function retryHandoff() {
    if (!meta.agent.slug) return;
    setBusy('register');
    setError(null);
    try {
      await registerManaged(meta.agent.slug, {
        account: meta.account as Hex,
        chainId: meta.chainId,
        session: reviveSession(meta),
      });
      markRegistered(meta.id);
      clearFundingCheckpointForSession(
        meta.chainId,
        meta.account as Hex,
        meta.agent.slug,
        meta.correlatedAt ?? meta.grantedAt,
      );
      setRunnerStatus('checking');
      onChange();
      toast({ title: 'Handoff restored', detail: 'The runner accepted the existing session; no new key was granted.', kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Handoff failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const service = managedServiceStatus(validity, recoveryOnly, runnerStatus);
  const sessionValid = service.sessionValid;
  const canRetryHandoff = shouldOfferManagedHandoffRetry(
    validity,
    recoveryOnly,
    runnerStatus,
    meta.registrationStatus,
  );
  // Receipt tokens can be donated permissionlessly. A split is useful
  // position telemetry, but it is not evidence that the runner stopped.
  const active = service.active;
  const statusLabel = service.label;
  const venueBadge =
    pos?.venue === 'idle'
      ? 'bg-surface-2 text-muted'
      : 'bg-success/15 text-success';

  // Live yield facts for the dashboard.
  const policy = managedPolicyDisplay(meta.agent);
  const rationale = pos && pos.venue !== 'split' && apys && policy
    ? rotationRationale(pos.venue, apys, policy)
    : null;
  const currentApyPct = rationale?.currentApyBps != null ? rationale.currentApyBps / 100 : null;
  const principal = meta.principalUsdt != null ? Number(meta.principalUsdt) : null;
  const positionValue = pos ? Number(pos.totalUsdt) : null;
  const deployed = pos ? pos.deployedWei > USDT_DUST_WEI : false;
  // This is deliberately a net balance change, not an earnings claim: later
  // deposits and withdrawals are indistinguishable from yield in balance-only
  // data without authenticated cash-flow accounting.
  const netChange = principal != null && positionValue != null ? positionValue - principal : null;
  const fmtChange = (n: number) => (Math.abs(n) >= 0.01 ? n.toFixed(2) : n.toFixed(6));

  return (
    <li id={`session-${meta.id}`} className="scroll-mt-24 rounded-xl border border-border bg-surface p-5">
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
          {statusLabel}
        </span>
      </div>

      {recoveryOnly && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-primary/35 bg-primary/10 p-3 text-xs leading-relaxed"
        >
          <p className="font-semibold text-primary">Recovery mode · automation paused</p>
          <p className="mt-1 text-muted">
            New management is disabled for this router. Your position is still owned by your
            account. Idle funds can leave directly; a deployed position will use only a current
            debt-complete router, never this retired deployment.
          </p>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[1.2fr_1fr]">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs uppercase tracking-wide text-muted-2">
            {active ? 'Under management' : 'Account position'}
          </p>
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
      {(netChange != null || rationale) && (
        <div className={`mt-3 rounded-lg border border-border bg-[linear-gradient(180deg,rgba(16,185,129,0.05),transparent)] p-3 ${active ? 'agp-working' : ''}`}>
          {active && (
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-success">
              <span className="agp-think-dots inline-flex items-center gap-[3px]" aria-hidden>
                <i /><i /><i />
              </span>
              Agent is optimizing your yield
            </p>
          )}
          {netChange != null && deployed && (
            <p className="text-sm">
              <span className="text-muted-2">Net balance change </span>
              <span className={`tabular font-mono font-semibold ${netChange >= 0 ? 'text-success' : 'text-danger'}`}>
                {netChange >= 0 ? '+' : ''}{fmtChange(netChange)} {token}
              </span>
              {principal != null && (
                <span className="text-xs text-muted-2"> on {principal.toFixed(2)} held at activation</span>
              )}
              <span className="text-xs text-muted-2"> (includes transfers and yield)</span>
            </p>
          )}
          {rationale && apys && (
            <p className="mt-1 text-xs leading-relaxed text-muted-2">
              Venus {(apys.venusApyBps / 100).toFixed(2)}% vs Aave {(apys.aaveApyBps / 100).toFixed(2)}%.{' '}
              {!active
                ? 'This session is not currently managing the position; live rates are shown for reference.'
                : pos && pos.venue === 'idle'
                  ? 'Awaiting the agent’s next sweep to deploy into the higher one.'
                  : rationale.edgeBps <= 0
                    ? `Holding the higher-rate venue; ${rationale.otherName} trails by ${Math.abs(rationale.edgeBps / 100).toFixed(2)}%.`
                    : (rationale.thresholdInclusive
                      ? rationale.edgeBps < rationale.hysteresisBps
                      : rationale.edgeBps <= rationale.hysteresisBps)
                      ? `${rationale.otherName} leads by ${(rationale.edgeBps / 100).toFixed(2)}%, which does not clear this agent’s ${(rationale.hysteresisBps / 100).toFixed(2)}% move threshold.`
                      : `${rationale.otherName} leads by ${(rationale.edgeBps / 100).toFixed(2)}%. The lead must persist for ${rationale.confirmations} consecutive checks${rationale.checkEveryHours != null ? ` spaced ${rationale.checkEveryHours} hours apart` : ''}${rationale.minHoursBetweenMoves != null ? `, with at least ${rationale.minHoursBetweenMoves} hours between moves` : ''}.`}
            </p>
          )}
        </div>
      )}

      {historyUnavailable && (
        <p className="mt-4 text-xs text-muted-2">
          Account/router activity is unavailable; no empty history is being inferred.
        </p>
      )}
      {history && history.events.length > 0 && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-muted-2">Account/router activity</p>
          <ul className="mt-2 space-y-1.5">
            {history.events.slice(0, 6).map((e) => (
              <li key={`${e.txHash}-${e.logIndex}`} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
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
          <p className="mt-2 text-[11px] text-muted-2">
            Permissionless calls by this account; the event does not identify which agent or owner action signed it.
            {!history.complete && history.scannedFrom != null
              ? ` Recent scan only, from block ${history.scannedFrom.toString()}.`
              : ''}
          </p>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3">
        <label
          htmlFor={destinationInputId}
          className="block text-xs uppercase tracking-wide text-muted-2"
        >
          {recoveryOnly ? `Recover ${token} to your wallet` : 'Withdraw to your wallet'}
        </label>
        {!configValid && (
          <p className="mt-2 text-xs text-danger">
            This saved record doesn&apos;t map to a single known router on this network, so its
            managed actions are disabled. Use &ldquo;Forget&rdquo; and re-activate from the agent page.
          </p>
        )}
        <input
          id={destinationInputId}
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
            disabled={
              !configValid
              || busy !== null
              || !destValid
              || (pos != null && pos.idleWei === 0n && (pos.deployedWei === 0n || !canRecoverDeployed))
            }
            className="rounded border border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {busy === 'usdt'
              ? recoveryOnly ? 'Recovering…' : 'Withdrawing…'
              : `${recoveryOnly ? 'Recover' : 'Withdraw'} ${token}${pos
                  ? canRecoverDeployed
                    ? ` (up to ${Number(pos.totalUsdt).toFixed(2)})`
                    : ` (${Number(pos.idleUsdt).toFixed(2)})`
                  : ''}`}
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
          {recoveryOnly
            ? canRecoverDeployed
              ? `Recover ${token} asks for your passkey, revokes the old session, approves the current debt-complete router, unwinds there, then sends the idle balance to your destination.`
              : `Only already-idle ${token} can be sent now. Deployed funds stay in your account until a debt-complete replacement router is live.`
            : `Withdraw ${token} stops the agent, unwinds every debt-free venue leg, then sends the available balance to your address. Debt-encumbered collateral remains in your account.`}{' '}
          Withdraw BNB (available once {token} is out) keeps a small reserve so the
          transaction can pay its own gas.
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {canRetryHandoff && (
          <button
            onClick={retryHandoff}
            disabled={busy !== null}
            className="rounded border border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {busy === 'register' ? 'Retrying handoff…' : 'Retry handoff'}
          </button>
        )}
        {sessionValid && (
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
          disabled={busy !== null || validity !== 'invalid'}
          title={validity !== 'invalid' ? 'Confirm the key is stopped before forgetting this recovery record' : undefined}
          className="rounded border border-border-strong px-3 py-1.5 text-xs text-muted hover:border-border-strong disabled:opacity-50"
        >
          Forget record
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-2">
        Funds stay in your account the whole time. Stop revokes the agent&apos;s
        key; your funds remain and can still be withdrawn above.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}
