/**
 * Grid: WBNB/USDT mean-reversion grid on BSC. Price reference is the deepest
 * PancakeSwap V3 WBNB/USDT pool; execution is Ophis (CoW) swaps only.
 * Four levels each side of the first-tick center at 1.5 percent spacing,
 * $2 clips shrunk to what the spending leg can actually fund (never grown),
 * hard halts on a 5 percent inventory drawdown. The grid re-centers on the live
 * price, up to a shared daily cap, when a breakout leaves the band or when a
 * drifted center has gone half a day without a fill; past that cap a breakout
 * halts. All sizing comes from live balances every tick.
 *
 * The strategy arithmetic lives in ../grid-core, shared with grid-b. This file
 * owns THIS grid's parameters, its pair, and its tick wiring: every core call
 * below passes the constants declared here, so grid-b's wider ladder and
 * smaller clips can never leak in. The exported helpers keep their original
 * signatures and defaults, so nothing that consumed them changed.
 */
import { executeOphisSwap } from '@ophis/agent-swap';
import { TOKENS_BSC, toBaseUnits, fromBaseUnits } from '@agripinaa/shared';

import {
  clipForLevel as coreClipForLevel,
  computeLevels as coreComputeLevels,
  detectCrossing,
  evaluateGuards as coreEvaluateGuards,
  effectiveClipUsd as coreEffectiveClipUsd,
  inventoryValueUsd,
  isCooldownActive as coreIsCooldownActive,
  isGridStale as coreIsGridStale,
  isLossBreach as coreIsLossBreach,
  isSuppressedByMark,
  isTrendBreakout as coreIsTrendBreakout,
  isWithinUnmarkBand as coreIsWithinUnmarkBand,
  maybeRecenter as coreMaybeRecenter,
  priceFromSqrtPriceX96,
  readBalances as coreReadBalances,
  readMidPrice,
  resolveReferencePool as coreResolveReferencePool,
  toSignificant,
  unmarkNearCenter as coreUnmarkNearCenter,
  type FillRecord,
  type GridLevel,
  type GridPair,
  type GridSide,
  type GuardFailure,
  type GuardResult,
  type RecenterReason,
  type ReferencePool,
} from '../grid-core';
import { ChassisOphisWallet } from '../ophis-wallet';
import { independentMinimumBuyAmount } from '../quote-guard';
import type { AgentContext, AgentModule } from '../types';

/* Re-exported rather than wrapped: these take no grid parameter, so there is
 * nothing for this module to bind. */
export { detectCrossing, inventoryValueUsd, isSuppressedByMark, priceFromSqrtPriceX96, toSignificant };
export type { FillRecord, GridLevel, GridSide, GuardFailure, GuardResult, RecenterReason };

const WBNB = TOKENS_BSC.WBNB!;
const USDT = TOKENS_BSC.USDT!;

/** This grid's pair, base first: the price is USDT per WBNB. */
const PAIR: GridPair = { base: WBNB, quote: USDT };
const CLIP_SYMBOLS = { base: 'WBNB', quote: 'USDT' } as const;

export const GRID_SPACING = 0.015;
export const GRID_LEVELS_PER_SIDE = 4;
/** Desired clip. The clip actually traded is this shrunk to what the wallet can
 * fund, never more: see effectiveClipUsd. */
export const CLIP_USD = 2;
/**
 * Floor for an adapted clip. Mirrors MIN_SWAP_NOTIONAL_USD in lp-range.ts,
 * which is the minimum swap notional that agent already applies to this same
 * pair on this same venue, so the two agents agree on what is worth swapping.
 * Mirrored rather than imported because no agent module imports another: they
 * are independently loaded units, and reaching into lp-range would drag its
 * whole dependency chain in for one number.
 */
export const MIN_CLIP_USD = 1;
// Must exceed the Ophis/CoW order validity (~30 min): otherwise a new clip can
// be submitted while a prior order is still executable, and after a re-center
// the two could fill against different grid regimes with unreserved balance.
export const COOLDOWN_MS = 31 * 60_000;
export const MAX_TRADES_PER_DAY = 12;
export const TREND_MAX_DEVIATION = 0.06;
export const LOSS_FLOOR_FRACTION = 0.95;
/** On a breakout the grid re-centers on the current price instead of halting
 * forever, up to this many times per rolling day. Past the cap it halts, so a
 * sustained runaway trend still stops the agent rather than chasing it. */
export const MAX_RECENTERS_PER_DAY = 3;
/**
 * How long the grid may go without a fill before a drifted center counts as
 * stale. Twelve hours is well past the 31 minute cooldown and the 2 minute
 * tick, so a merely quiet session never trips it, while a center the market no
 * longer reaches is caught within half a day instead of never. Exported so it
 * is testable and tunable in one place.
 */
export const STALE_RECENTER_MS = 12 * 60 * 60_000;
const SLIPPAGE_BPS = 100;
const FILL_HISTORY = 20;

/* ------------------------------ pure logic ------------------------------ */
/* Thin bindings of the shared core to this grid's constants. The defaults are
 * what every caller and test already relied on. */

export function computeLevels(
  center: number,
  spacing = GRID_SPACING,
  perSide = GRID_LEVELS_PER_SIDE,
) {
  return coreComputeLevels(center, spacing, perSide);
}

export function isWithinUnmarkBand(price: number, center: number, spacing = GRID_SPACING): boolean {
  return coreIsWithinUnmarkBand(price, center, spacing);
}

export function unmarkNearCenter(
  price: number,
  center: number,
  crossed: string[],
  spacing = GRID_SPACING,
): string[] {
  return coreUnmarkNearCenter(price, center, crossed, spacing);
}

export function isGridStale(
  nowMs: number,
  lastFillAtMs: number | null,
  price: number,
  center: number,
  staleMs = STALE_RECENTER_MS,
  spacing = GRID_SPACING,
): boolean {
  return coreIsGridStale(nowMs, lastFillAtMs, price, center, staleMs, spacing);
}

export function effectiveClipUsd(
  desiredUsd: number,
  affordableUsd: number,
  minUsd = MIN_CLIP_USD,
): number {
  return coreEffectiveClipUsd(desiredUsd, affordableUsd, minUsd);
}

export function clipForLevel(
  side: GridSide,
  price: number,
  clipUsd = CLIP_USD,
): { token: 'WBNB' | 'USDT'; amount: string } {
  return coreClipForLevel(side, price, clipUsd, CLIP_SYMBOLS);
}

export function isCooldownActive(
  nowMs: number,
  lastFillAtMs: number | null,
  cooldownMs = COOLDOWN_MS,
): boolean {
  return coreIsCooldownActive(nowMs, lastFillAtMs, cooldownMs);
}

export function isTrendBreakout(
  price: number,
  center: number,
  maxDeviation = TREND_MAX_DEVIATION,
): boolean {
  return coreIsTrendBreakout(price, center, maxDeviation);
}

export function isLossBreach(
  inventoryNowUsd: number,
  inventoryStartUsd: number,
  floor = LOSS_FLOOR_FRACTION,
): boolean {
  return coreIsLossBreach(inventoryNowUsd, inventoryStartUsd, floor);
}

/** The core guard input with this grid's thresholds left optional, since the
 * tick and the tests supply only the situation. */
export interface GuardInput {
  nowMs: number;
  lastFillAtMs: number | null;
  price: number;
  center: number;
  inventoryNowUsd: number;
  inventoryStartUsd: number;
  clipBaseUnits: bigint;
  balanceBaseUnits: bigint;
  /** Lazy so the persisted action counter records only when the chain
   * actually reaches it, and never during cooldown. */
  allowTrade: () => boolean;
  cooldownMs?: number;
  maxDeviation?: number;
  lossFloor?: number;
}

export function evaluateGuards(input: GuardInput): GuardResult {
  return coreEvaluateGuards({
    ...input,
    cooldownMs: input.cooldownMs ?? COOLDOWN_MS,
    maxDeviation: input.maxDeviation ?? TREND_MAX_DEVIATION,
    lossFloor: input.lossFloor ?? LOSS_FLOOR_FRACTION,
  });
}

export function maybeRecenter(
  ctx: AgentContext,
  price: number,
  inventoryNowUsd: number,
  reason: RecenterReason = 'breakout',
  detail: Record<string, unknown> = {},
): boolean {
  return coreMaybeRecenter(ctx, price, inventoryNowUsd, MAX_RECENTERS_PER_DAY, reason, detail);
}

/* ----------------------------- chain access ----------------------------- */

async function resolveReferencePool(ctx: AgentContext): Promise<ReferencePool> {
  return coreResolveReferencePool(ctx, PAIR);
}

async function readBalances(ctx: AgentContext): Promise<{ wbnb: bigint; usdt: bigint }> {
  const { base, quote } = await coreReadBalances(ctx, PAIR);
  return { wbnb: base, usdt: quote };
}

/* -------------------------------- module -------------------------------- */

export const gridAgent: AgentModule = {
  name: 'grid',
  category: 'grid',
  tickIntervalMs: 120_000,

  async tick(ctx) {
    if (ctx.breakers.isHalted().halted) return;

    const pool = await resolveReferencePool(ctx);
    const price = await readMidPrice(ctx, pool);
    const balances = await readBalances(ctx);
    const wbnbWhole = Number(fromBaseUnits(balances.wbnb, WBNB.decimals));
    const usdtWhole = Number(fromBaseUnits(balances.usdt, USDT.decimals));
    const inventoryNowUsd = inventoryValueUsd(wbnbWhole, usdtWhole, price);

    // Fail SAFE on a corrupt/abnormal read: a non-finite or non-positive price
    // or inventory would silently make the breakout/loss comparisons false or
    // poison the stored center. Skip the tick (transient) rather than trade.
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(inventoryNowUsd) || inventoryNowUsd <= 0) {
      ctx.log({ event: 'bad-read', price, inventoryNowUsd });
      return;
    }

    const storedCenter = ctx.state.get<number | null>('center', null);
    if (storedCenter === null) {
      // Write the loss baseline BEFORE the center. Each set is atomic, so a
      // crash mid-init can leave a baseline without a center (which re-inits
      // cleanly) but never a center without a baseline.
      ctx.state.set('inventoryStartUsd', inventoryNowUsd);
      ctx.state.set('lastPrice', price);
      ctx.state.set('center', price);
      ctx.log({
        event: 'grid-init',
        center: price,
        inventoryStartUsd: inventoryNowUsd,
        wbnbWhole,
        usdtWhole,
        pool: pool.address,
        feeTier: pool.fee,
      });
      return;
    }
    const center = storedCenter;
    // Fail CLOSED if a center exists without a valid loss baseline: halt rather
    // than trade with the drawdown floor silently disabled.
    const inventoryStartUsd = ctx.state.get<number | null>('inventoryStartUsd', null);
    if (inventoryStartUsd === null || !Number.isFinite(inventoryStartUsd) || inventoryStartUsd <= 0) {
      ctx.log({ event: 'state-incomplete', reason: 'center set without a valid loss baseline' });
      ctx.breakers.halt('state-incomplete');
      return;
    }
    const prevPrice = ctx.state.get<number>('lastPrice', price);
    ctx.state.set('lastPrice', price);

    // Halting conditions first, and CAPITAL PROTECTION BEFORE ADAPTATION: a
    // loss breach always halts, even when it coincides with a breakout, so
    // re-centering can never bypass the drawdown floor. Only a breakout that
    // did NOT breach the floor re-centers (up to the daily cap); past the cap
    // a sustained trend halts rather than being chased.
    if (isLossBreach(inventoryNowUsd, inventoryStartUsd)) {
      ctx.log({ event: 'daily-loss', inventoryNowUsd, inventoryStartUsd });
      ctx.breakers.halt('daily-loss');
      return;
    }
    if (isTrendBreakout(price, center)) {
      // Require the breakout to persist across two ticks before re-centering,
      // so a single-tick spike or whipsaw doesn't re-arm the grid into noise.
      const streak = ctx.state.get<number>('breakoutStreak', 0) + 1;
      ctx.state.set('breakoutStreak', streak);
      if (streak < 2) {
        ctx.log({ event: 'breakout-observed', price, center, streak });
        return;
      }
      ctx.state.set('breakoutStreak', 0);
      if (maybeRecenter(ctx, price, inventoryNowUsd)) return;
      ctx.log({ event: 'trend-breakout', price, center });
      ctx.breakers.halt('trend-breakout');
      return;
    }
    // Back inside the band: clear any partial breakout streak.
    if (ctx.state.get<number>('breakoutStreak', 0) !== 0) ctx.state.set('breakoutStreak', 0);

    let crossed = ctx.state.get<string[]>('crossedLevels', []);
    const afterUnmark = unmarkNearCenter(price, center, crossed);
    if (afterUnmark.length !== crossed.length) {
      ctx.log({ event: 'levels-unmarked', cleared: crossed, price, center });
      ctx.state.set('crossedLevels', afterUnmark);
      crossed = afterUnmark;
    }

    const levels = computeLevels(center);
    const hit = detectCrossing(prevPrice, price, levels, crossed);
    if (!hit) {
      // Breakout/loss halts already handled above; nothing to trade this tick.
      // Nothing to trade for STALE_RECENTER_MS either, while a mark is sitting
      // on a level the price already satisfies and cannot clear, means the
      // center has drifted out of the market's reach and the grid is not quiet
      // but dead. Re-arm it on the live price through the SAME capped path a
      // breakout uses. BOTH conditions are required: the drought says the grid
      // cannot recover on its own, the mark says there is something to recover.
      // Dropping the second turns this into chasing, which measurably costs
      // fills and eats the breakout budget (see isSuppressedByMark). Checked
      // only in this branch, so a re-center can never pre-empt a clip that was
      // about to trade.
      const nowMs = Date.now();
      const lastFillAtMs = ctx.state.get<number | null>('lastFillAt', null);
      if (
        lastFillAtMs !== null &&
        isGridStale(nowMs, lastFillAtMs, price, center) &&
        isSuppressedByMark(price, levels, crossed)
      ) {
        const hoursSinceLastFill = (nowMs - lastFillAtMs) / 3_600_000;
        if (maybeRecenter(ctx, price, inventoryNowUsd, 'stale', { hoursSinceLastFill })) return;
        // Budget spent. Fall through to the ordinary tick log rather than
        // halting: a grid with no fills is idle, not a runaway trend, and the
        // breakout path still owns the halt.
      }
      ctx.log({ event: 'tick', price, center, inventoryNowUsd, crossedCount: crossed.length });
      return;
    }

    // Size the clip to what this leg can actually fund. A buy spends USDT, a
    // sell spends WBNB, so only the leg being spent constrains the clip.
    const affordableUsd = hit.level.side === 'buy' ? usdtWhole : wbnbWhole * price;
    const clipUsd = effectiveClipUsd(CLIP_USD, affordableUsd, MIN_CLIP_USD);
    const reducedClip = clipUsd > 0 && clipUsd < CLIP_USD;
    // 0 means the leg cannot fund even the minimum. Quote the DESIRED size so
    // the balance guard below blocks it with insufficient-balance exactly as an
    // empty wallet does today; quoting 0 would throw in toSignificant instead.
    const clip = clipForLevel(hit.level.side, price, clipUsd > 0 ? clipUsd : CLIP_USD);
    // Carried on the existing trade events rather than a new event type, so the
    // journal shows when a clip was shrunk to fit the wallet.
    const clipAdaptation = reducedClip
      ? { desiredClipUsd: CLIP_USD, effectiveClipUsd: clipUsd }
      : {};
    const clipToken = clip.token === 'WBNB' ? WBNB : USDT;
    const clipBaseUnits = toBaseUnits(clip.amount, clipToken.decimals);
    const balanceBaseUnits = clip.token === 'WBNB' ? balances.wbnb : balances.usdt;

    const guard = evaluateGuards({
      nowMs: Date.now(),
      lastFillAtMs: ctx.state.get<number | null>('lastFillAt', null),
      price,
      center,
      inventoryNowUsd,
      inventoryStartUsd,
      clipBaseUnits,
      balanceBaseUnits,
      allowTrade: () => ctx.breakers.allowAction('trade', MAX_TRADES_PER_DAY),
    });
    if (!guard.ok) {
      ctx.log({
        event: 'trade-blocked',
        reason: guard.reason,
        level: hit.level.key,
        price,
        center,
        inventoryNowUsd,
        ...clipAdaptation,
      });
      if (guard.halt) ctx.breakers.halt(guard.reason);
      return;
    }

    const sellToken = hit.level.side === 'sell' ? WBNB.address : USDT.address;
    const buyToken = hit.level.side === 'sell' ? USDT.address : WBNB.address;
    ctx.log({
      event: 'trade-intent',
      side: hit.level.side,
      level: hit.level.key,
      crossedThisTick: hit.crossedThisTick,
      sellToken,
      buyToken,
      sellAmount: clip.amount,
      price,
      center,
      ...clipAdaptation,
    });

    // Persist the cooldown anchor and level mark BEFORE submitting: a crash
    // in the submit window must not lose them, or a restart would re-fire the
    // same clip with no cooldown. Worst case on a failed submit is one
    // skipped legitimate clip, the safe direction.
    ctx.state.set('lastFillAt', Date.now());
    ctx.state.set('crossedLevels', [...crossed, hit.level.key]);

    const wallet = new ChassisOphisWallet(ctx.account, ctx.publicClient, ctx.walletClient);
    const result = await executeOphisSwap(
      wallet,
      {
        sellToken,
        buyToken,
        sellAmount: clip.amount,
        slippageBps: SLIPPAGE_BPS,
        minimumBuyAmount: independentMinimumBuyAmount({
          sellAmount: clip.amount,
          buyUnitsPerSellUnit: hit.level.side === 'sell' ? price : 1 / price,
          buyDecimals: hit.level.side === 'sell' ? USDT.decimals : WBNB.decimals,
        }),
      },
      {},
    );
    ctx.log({
      event: 'trade-submitted',
      orderUid: result.orderUid,
      side: hit.level.side,
      level: hit.level.key,
      clipToken: clip.token,
      clipAmount: clip.amount,
      price,
      center,
      minBuyAmount: result.minBuyAmount,
      explorerUrl: result.explorerUrl,
      enrollmentWarning: result.enrollmentWarning ?? null,
      ...clipAdaptation,
    });

    const fill: FillRecord = {
      at: new Date().toISOString(),
      side: hit.level.side,
      level: hit.level.key,
      clipToken: clip.token,
      clipAmount: clip.amount,
      price,
      orderUid: result.orderUid,
    };
    const fills = [...ctx.state.get<FillRecord[]>('fills', []), fill].slice(-FILL_HISTORY);
    ctx.state.set('fills', fills);
  },

  async status(ctx) {
    const halted = ctx.breakers.isHalted();
    const center = ctx.state.get<number | null>('center', null);
    const crossed = new Set(ctx.state.get<string[]>('crossedLevels', []));
    const fills = ctx.state.get<FillRecord[]>('fills', []);
    const inventoryStartUsd = ctx.state.get<number | null>('inventoryStartUsd', null);

    let price: number | null = null;
    let inventoryNowUsd: number | null = null;
    let error: string | undefined;
    try {
      const pool = await resolveReferencePool(ctx);
      price = await readMidPrice(ctx, pool);
      const balances = await readBalances(ctx);
      inventoryNowUsd = inventoryValueUsd(
        Number(fromBaseUnits(balances.wbnb, WBNB.decimals)),
        Number(fromBaseUnits(balances.usdt, USDT.decimals)),
        price,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      center,
      price,
      levels:
        center === null
          ? []
          : computeLevels(center).map((l) => ({
              price: l.price,
              side: l.side,
              crossed: crossed.has(l.key),
            })),
      fills: fills.slice(-10),
      inventoryStartUsd,
      inventoryNowUsd,
      halted,
      ...(error ? { error } : {}),
    };
  },
};
