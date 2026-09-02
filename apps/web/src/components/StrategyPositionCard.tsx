'use client';

import {
  managedStrategyFor,
  type ManagedStrategySlug,
} from '@agripinaa/shared/managed-strategies';
import { formatUnits, type Hex } from 'viem';
import { useCallback, useEffect, useRef, useState } from 'react';

import { altanaClient } from '@/lib/altana';
import {
  assertSafeWithdrawalDestination,
  destinationProblem,
} from '@/lib/managed';
import {
  effectiveManagedPositionTokenId,
  readManagedRunnerSnapshot,
  type ManagedRunnerStatus,
} from '@/lib/managed-router';
import {
  readStrategyAccountPosition,
  rangerEmptyState,
  strategyAccountReadProblem,
  strategyPositionViewState,
  type RangerPosition,
  type StrategyAccountPosition,
  type StrategyAssetBalance,
} from '@/lib/strategy-position';
import {
  closeRangerPosition,
  recoverStrategyTokens,
  stopAllAccountSessions,
} from '@/lib/strategy-recovery';
import type { StoredSessionMeta } from '@/lib/session-store';
import { toast } from '@/lib/toast';

import { SessionCard, type SessionValidity } from './SessionCard';
import { TokenLogo } from './icons';

function conciseAmount(value: number, symbol: string): string {
  if (!Number.isFinite(value)) return '—';
  const decimals = symbol === 'USDT' || symbol === 'USDC'
    ? 2
    : value >= 1 ? 4 : 6;
  return value.toLocaleString('en-US', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: symbol === 'USDT' || symbol === 'USDC' ? 2 : 0,
  });
}

function rangerAssetAmount(ranger: RangerPosition | null, asset: StrategyAssetBalance): number {
  if (!ranger) return 0;
  if (ranger.token0 === asset.symbol) {
    return ranger.estimated0 + Number(formatUnits(ranger.owed0, asset.decimals));
  }
  if (ranger.token1 === asset.symbol) {
    return ranger.estimated1 + Number(formatUnits(ranger.owed1, asset.decimals));
  }
  return 0;
}

function runnerCopy(status: ManagedRunnerStatus, validity: SessionValidity) {
  if (validity === 'checking') return { label: 'checking agent…', cls: 'bg-surface text-muted-2' };
  if (validity === 'invalid') return { label: 'agent stopped', cls: 'bg-surface text-muted-2' };
  if (validity === 'unknown') return { label: 'authority unknown', cls: 'bg-primary/15 text-primary' };
  if (status === 'ready') return { label: 'agent working', cls: 'bg-success/15 text-success' };
  if (status === 'halted') return { label: 'agent halted', cls: 'bg-danger/15 text-danger' };
  if (status === 'not-registered') return { label: 'handoff incomplete', cls: 'bg-primary/15 text-primary' };
  if (status === 'checking') return { label: 'checking service…', cls: 'bg-surface text-muted-2' };
  return { label: 'service unavailable', cls: 'bg-surface text-muted-2' };
}

function RangerDetails({
  ranger,
  runner,
  validity,
  positionTokenId,
}: {
  ranger: RangerPosition | null;
  runner: ManagedRunnerStatus;
  validity: SessionValidity;
  positionTokenId: string | null;
}) {
  if (!ranger) {
    const emptyState = rangerEmptyState(runner, validity, positionTokenId);
    if (emptyState === 'recorded-unavailable') {
      return (
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-sm font-medium">Recorded Pancake position unavailable</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-2">
            Ranger recorded NFT #{positionTokenId}, but its WBNB/USDT liquidity is no longer
            readable as an active position. The idle balances above are still live on-chain.
          </p>
        </div>
      );
    }
    if (emptyState === 'inactive') {
      return (
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-sm font-medium">No tracked Pancake position</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-2">
            The runner is not currently confirmed active, so this dashboard will not describe
            Ranger as preparing a position. The idle balances above remain live on-chain.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-border bg-surface-2 p-3">
        <p className="text-sm font-medium">Waiting for the first Pancake V3 range</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-2">
          The idle WBNB and USDT above remain in your account while Ranger prepares or rebalances
          the position. This card will show its NFT and live range as soon as it is minted.
        </p>
      </div>
    );
  }
  const state = ranger.rangeState === 'in-range'
    ? { label: 'in range', cls: 'bg-success/15 text-success' }
    : ranger.rangeState === 'out-of-range'
      ? { label: 'out of range', cls: 'bg-primary/15 text-primary' }
      : { label: 'range unavailable', cls: 'bg-surface text-muted-2' };
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-2">PancakeSwap V3 position</p>
          <a
            href={`https://bscscan.com/token/0x46A15B0b27311cedF172AB29E4f4766fbE7F4364?a=${ranger.tokenId.toString()}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block font-mono text-sm font-semibold text-primary hover:underline"
          >
            NFT #{ranger.tokenId.toString()} ↗
          </a>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${state.cls}`}>{state.label}</span>
      </div>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-2">Pool</dt>
          <dd className="mt-0.5">{ranger.token0}/{ranger.token1} · {(ranger.fee / 10_000).toFixed(2)}%</dd>
        </div>
        <div>
          <dt className="text-muted-2">Range ticks</dt>
          <dd className="mt-0.5 font-mono">{ranger.tickLower} → {ranger.tickUpper}</dd>
        </div>
        <div>
          <dt className="text-muted-2">Current tick</dt>
          <dd className="mt-0.5 font-mono">{ranger.currentTick ?? 'unavailable'}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-2">
        Position asset amounts above are live estimates from the NFT liquidity and current pool tick.
      </p>
    </div>
  );
}

function StrategyRecoveryPanel({
  meta,
  slug,
  position,
  onRecovered,
}: {
  meta: StoredSessionMeta;
  slug: ManagedStrategySlug;
  position: StrategyAccountPosition;
  onRecovered: () => void;
}) {
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `strategy-recovery-destination-${meta.id}`;
  const problem = destination
    ? destinationProblem(destination, meta.account, meta.chainId)
    : null;
  const hasTokens = position.assets.some((asset) => asset.wei > 0n);
  const hasRanger = slug === 'lp-range' && position.ranger !== null;

  async function recover() {
    if (!destination || problem) {
      setError(problem ?? 'Enter an external wallet address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (meta.chainId !== 56) throw new Error('Strategy recovery is available only on BNB Chain mainnet.');
      const account = meta.account as Hex;
      const to = destination as Hex;
      // No passkey prompt, session revocation, or position close occurs until
      // independent RPCs agree that the payout address is an EOA.
      await assertSafeWithdrawalDestination(account, meta.chainId, to);
      const wallet = await altanaClient().recoverFromPasskey({ chainId: meta.chainId });
      if (wallet.address.toLowerCase() !== account.toLowerCase()) {
        throw new Error('This passkey controls a different account than this strategy position.');
      }
      await stopAllAccountSessions(wallet, account, meta.chainId, meta);
      if (slug === 'lp-range' && position.ranger) {
        await closeRangerPosition(wallet, account, position.ranger.tokenId);
      }
      const symbols = await recoverStrategyTokens(wallet, slug, account, to);
      onRecovered();
      toast({
        title: 'Strategy assets recovered',
        detail: `${symbols.join(' + ')} sent to ${destination.slice(0, 10)}…`,
        kind: 'success',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      // Earlier confirmed phases are intentionally resumable. Refresh so a
      // stopped key or already-collected NFT is never hidden by stale UI.
      onRecovered();
      toast({ title: 'Recovery stopped', detail: message.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  if (!hasTokens && !hasRanger) return null;
  return (
    <div className="mt-4 rounded-lg border border-primary/35 bg-primary/5 p-3">
      <label htmlFor={inputId} className="block text-xs uppercase tracking-wide text-muted-2">
        Stop and recover to your wallet
      </label>
      <input
        id={inputId}
        value={destination}
        onChange={(event) => setDestination(event.target.value.trim())}
        spellCheck={false}
        placeholder="0x… external wallet address"
        className={`mt-2 w-full rounded-lg border bg-surface p-2.5 font-mono text-xs focus:outline-none ${
          destination && problem
            ? 'border-danger focus:border-danger'
            : 'border-border-strong focus:border-primary'
        }`}
      />
      {destination && problem && <p className="mt-1 text-xs text-danger">{problem}</p>}
      <button
        type="button"
        onClick={recover}
        disabled={busy || !destination || problem !== null}
        className="mt-3 rounded border border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
      >
        {busy ? 'Recovering…' : `Stop & recover ${position.assets.map((asset) => asset.symbol).join('/')}`}
      </button>
      <p className="mt-2 text-xs leading-relaxed text-muted-2">
        This stops every on-chain session sharing this account. {hasRanger
          ? 'Ranger liquidity is closed and collected through the pinned Pancake position manager. '
          : ''}
        Venue allowances are reset before exact, freshly read token balances are sent. Native BNB
        stays behind as recovery gas until every account position is empty.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function StrategyPositionCard({
  meta,
  onChange,
}: {
  meta: StoredSessionMeta;
  onChange: () => void;
}) {
  const slug = meta.agent.slug as ManagedStrategySlug | undefined;
  const strategy = slug ? managedStrategyFor(slug) : undefined;
  const [position, setPosition] = useState<StrategyAccountPosition | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [runner, setRunner] = useState<ManagedRunnerStatus>('checking');
  const [rangerTokenId, setRangerTokenId] = useState<string | null>(null);
  const lastRangerTokenId = useRef<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const target = strategy?.callScopes[0]?.to;
  const accountProblem = strategyAccountReadProblem(meta.account);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!slug || !strategy || accountProblem) return;
    let cancelled = false;
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const snapshot = target
          ? await readManagedRunnerSnapshot(slug, meta.account, target)
          : { service: 'unavailable' as const, positionTokenId: null, reachable: false };
        if (!cancelled) setRunner(snapshot.service);
        const positionTokenId = effectiveManagedPositionTokenId(
          snapshot,
          lastRangerTokenId.current,
        );
        if (snapshot.reachable) {
          lastRangerTokenId.current = positionTokenId;
        }
        if (!cancelled) setRangerTokenId(positionTokenId);
        const next = await readStrategyAccountPosition(
          slug,
          meta.account as `0x${string}`,
          slug === 'lp-range' ? positionTokenId : null,
        );
        if (!cancelled) {
          setPosition(next);
          setLoadError(false);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        running = false;
      }
    };
    const timer = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [accountProblem, meta.account, refreshKey, slug, strategy, target]);

  if (!strategy || !slug) return <SessionCard meta={meta} onChange={onChange} />;
  const positionView = strategyPositionViewState(position !== null, loadError);
  const recoveryRecordNeeded = positionView !== 'position'
    || position === null
    || position.ranger !== null
    || position.assets.some((asset) => asset.wei > 0n);
  return (
    <SessionCard
      meta={meta}
      forgetDisabled={recoveryRecordNeeded}
      forgetDisabledReason="Recover every token and Ranger NFT position before forgetting this record"
      onChange={() => {
        refresh();
        onChange();
      }}
      position={(validity) => {
        const service = runnerCopy(runner, validity);
        return (
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wide text-muted-2">Live account position</p>
            <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs ${service.cls}`}>
              {runner === 'ready' && validity === 'valid' && <span className="live-dot h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}
              {service.label}
            </span>
            <button
              type="button"
              onClick={refresh}
              className="text-xs font-medium text-primary hover:underline"
            >
              Refresh
            </button>
          </div>

          {accountProblem ? (
            <div role="alert" className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted">
              {accountProblem} Forget this saved entry and activate the agent again to restore live tracking.
            </div>
          ) : positionView === 'error' ? (
            <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-muted">
              Position data is temporarily unavailable. Last-known balances are hidden because
              they may be stale; your on-chain funds are unaffected.{' '}
              <button type="button" onClick={refresh} className="font-semibold text-primary hover:underline">
                Retry
              </button>
            </div>
          ) : positionView === 'position' && position ? (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {position.assets.map((asset) => {
                  const idle = Number(asset.formatted);
                  const deployed = rangerAssetAmount(position.ranger, asset);
                  return (
                    <div key={asset.symbol} className="rounded-lg border border-border bg-surface-2 p-3">
                      <div className="flex items-center gap-2 text-xs text-muted-2">
                        <TokenLogo symbol={asset.symbol} className="h-5 w-5" />
                        {asset.symbol}
                      </div>
                      <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                        {conciseAmount(idle + deployed, asset.symbol)}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-2">
                        {deployed > 0
                          ? `${conciseAmount(idle, asset.symbol)} idle + ~${conciseAmount(deployed, asset.symbol)} in position`
                          : 'Idle in your strategy account'}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-2">
                <TokenLogo symbol="BNB" className="h-4 w-4" />
                Gas reserve: <span className="font-mono text-foreground">{conciseAmount(Number(position.nativeBnb), 'BNB')} BNB</span>
              </p>
              {slug === 'lp-range' && (
                <div className="mt-3">
                  <RangerDetails
                    ranger={position.ranger}
                    runner={runner}
                    validity={validity}
                    positionTokenId={rangerTokenId}
                  />
                </div>
              )}
              {slug !== 'lp-range' && (
                <p className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted">
                  {strategy.summary} The balances above are read live from your dedicated strategy account.
                </p>
              )}
              <StrategyRecoveryPanel
                meta={meta}
                slug={slug}
                position={position}
                onRecovered={() => {
                  refresh();
                  onChange();
                }}
              />
            </>
          ) : (
            <div aria-label="Loading live position" className="mt-3 grid animate-pulse gap-3 sm:grid-cols-2">
              <div className="h-24 rounded-lg bg-surface-2" />
              <div className="h-24 rounded-lg bg-surface-2" />
            </div>
          )}
        </div>
        );
      }}
    />
  );
}
