/**
 * Grid: WBNB/USDT mean-reversion grid on BSC. Price reference is the deepest
 * PancakeSwap V3 WBNB/USDT pool; execution is Ophis (CoW) swaps only.
 * Four levels each side of the first-tick center at 1.5 percent spacing,
 * $2 clips shrunk to what the spending leg can actually fund (never grown),
 * hard halts on a 5 percent inventory drawdown. The grid re-centers on the live
 * price, up to a shared daily cap, when a breakout leaves the band or when a
 * drifted center has gone half a day without a fill; past that cap a breakout
 * halts. All sizing comes from live balances every tick.
 */
import { executeOphisSwap } from '@ophis/agent-swap';
import { TOKENS_BSC, toBaseUnits, fromBaseUnits } from '@agripinaa/shared';
import { erc20Abi, parseAbi } from 'viem';

import { ChassisOphisWallet } from '../ophis-wallet';
import type { AgentContext, AgentModule } from '../types';

const WBNB = TOKENS_BSC.WBNB!;
const USDT = TOKENS_BSC.USDT!;

/*
 * PancakeSwap V3 factory on BSC. Verified on-chain 2026-08-18 with tsx plus
 * viem readContract against https://bsc-rpc.publicnode.com:
 *   getPool(WBNB, USDT, 100)  -> 0x172fcD41E0913e95784454622d1c3724f546f849
 *     token0=USDT 0x55d398326f99059fF775485246999027B3197955
 *     token1=WBNB 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
 *     fee=100 liquidity=9294864249557931854010708
 *   getPool(WBNB, USDT, 500)  -> 0x36696169C63e42cd08ce11f5deeBbCeBae652050
 *     same token pair, fee=500, liquidity=1189316424598382352703067
 *   getPool(WBNB, USDT, 2500) -> 0x1401ff943D08a7E098328C1d3a9d388923B115D2
 *     same token pair, fee=2500, liquidity=19993289529169961286485
 * slot0 of the fee-100 pool implied about 603 USDT per WBNB, which matched
 * spot BNB at probe time. The deepest pool is fee tier 100; the agent still
 * re-resolves through the factory at runtime and validates token0/token1/fee
 * before caching, so a stale hardcode can never be traded against.
 */
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as const;
const FEE_TIERS = [100, 500, 2500] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);
// PancakeSwap V3 slot0 declares feeProtocol as uint32 (Uniswap uses uint8);
// both decode identically since every return word is 32 bytes.
const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
]);

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

export type GridSide = 'buy' | 'sell';

export interface GridLevel {
  key: string;
  side: GridSide;
  /** 1 is nearest to center, GRID_LEVELS_PER_SIDE is farthest. */
  index: number;
  price: number;
}

export interface FillRecord {
  at: string;
  side: GridSide;
  level: string;
  clipToken: 'WBNB' | 'USDT';
  clipAmount: string;
  price: number;
  orderUid: string;
}

/* ------------------------------ pure logic ------------------------------ */

export function computeLevels(
  center: number,
  spacing = GRID_SPACING,
  perSide = GRID_LEVELS_PER_SIDE,
): GridLevel[] {
  const levels: GridLevel[] = [];
  for (let i = 1; i <= perSide; i++) {
    levels.push({ key: `sell:${i}`, side: 'sell', index: i, price: center * (1 + spacing * i) });
  }
  for (let i = 1; i <= perSide; i++) {
    levels.push({ key: `buy:${i}`, side: 'buy', index: i, price: center * (1 - spacing * i) });
  }
  return levels;
}

/** USDT per WBNB from slot0. Both tokens are 18 decimals on BSC, so the raw
 * ratio needs no decimal adjustment. */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, wbnbIsToken0: boolean): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = ratio * ratio;
  return wbnbIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

function isBeyond(price: number, level: GridLevel): boolean {
  return level.side === 'sell' ? price >= level.price : price <= level.price;
}

/**
 * Pick the single level to trade this tick: the nearest-to-center level the
 * price sits beyond that is not marked crossed. When one tick jumps several
 * levels only the nearest trades now; the farther ones stay unmarked and are
 * picked up on later ticks while price remains beyond them (crossedThisTick
 * false marks that carried case for the log).
 */
export function detectCrossing(
  prevPrice: number,
  price: number,
  levels: GridLevel[],
  crossed: Iterable<string>,
): { level: GridLevel; crossedThisTick: boolean } | null {
  const marked = crossed instanceof Set ? (crossed as Set<string>) : new Set(crossed);
  const eligible = levels
    .filter((l) => !marked.has(l.key) && isBeyond(price, l))
    .sort((a, b) => a.index - b.index);
  const level = eligible[0];
  if (!level) return null;
  return { level, crossedThisTick: !isBeyond(prevPrice, level) };
}

/** The band around center in which marks clear: within half a grid step,
 * boundary inclusive. Formulated without division to keep the exact boundary
 * free of float artifacts. Shared by unmarkNearCenter and isGridStale so the
 * two can never disagree about where the band ends. */
export function isWithinUnmarkBand(price: number, center: number, spacing = GRID_SPACING): boolean {
  return Math.abs(price - center) <= center * (spacing / 2);
}

/** All marks clear once price returns to within half a grid step of center,
 * boundary inclusive. */
export function unmarkNearCenter(
  price: number,
  center: number,
  crossed: string[],
  spacing = GRID_SPACING,
): string[] {
  if (crossed.length === 0) return crossed;
  return isWithinUnmarkBand(price, center, spacing) ? [] : crossed;
}

/**
 * A center the market has left behind silences the grid permanently. Marks only
 * clear inside the un-mark band, so once price settles between two levels with
 * the near one marked, there is nothing left to trade and nothing that can
 * un-mark it: the only escape is a 6 percent breakout the range will never
 * reach. Staleness names exactly that shape, a long drought while price sits
 * where no mark can clear, and is the signal to re-arm around the live price.
 *
 * A null lastFillAtMs (never filled) is NOT stale. There is no drought to
 * measure from, and a freshly initialised grid sits on its own center by
 * construction, so treating it as infinitely stale would re-center off the
 * first small drift and burn the daily budget for nothing.
 *
 * Half the test only. It says the grid CANNOT recover on its own; pair it with
 * isSuppressedByMark, which says there is something to recover.
 */
export function isGridStale(
  nowMs: number,
  lastFillAtMs: number | null,
  price: number,
  center: number,
  staleMs = STALE_RECENTER_MS,
  spacing = GRID_SPACING,
): boolean {
  if (lastFillAtMs === null) return false;
  if (nowMs - lastFillAtMs < staleMs) return false;
  // Inside the band the marks clear on their own next tick, so the grid is
  // quiet rather than stuck: leave it to recover without spending budget.
  return !isWithinUnmarkBand(price, center, spacing);
}

/**
 * True when a mark is the only thing stopping a trade right now: price already
 * satisfies that level, and detectCrossing skips it purely because it is
 * marked. That is the pathology, stated exactly.
 *
 * This is what stops a re-center from CHASING the price, and it is not
 * cosmetic. A drought plus an out-of-band price, on its own, also fires on a
 * grid that is merely waiting for a 1.5 percent move; re-centering there resets
 * the distance to the nearest level from as little as 0.75 percent back to the
 * full 1.5 percent, pushing the next fill FURTHER away. Replaying the real BNB
 * tape (2026-07-25 to 2026-08-24, 2 minute samples) the looser rule fires 61
 * times in 30 days and cuts fills from 11 to 5, and over the last 7 days it
 * spends the shared re-center budget on chasing, so the next genuine breakout
 * finds the budget gone and halts the agent. With this condition it fires 5
 * times and the fills survive.
 *
 * It strictly implies the un-mark band test, since a level sits at least a full
 * step from center and so price beyond one is more than half a step out.
 */
export function isSuppressedByMark(
  price: number,
  levels: GridLevel[],
  crossed: Iterable<string>,
): boolean {
  const marked = crossed instanceof Set ? (crossed as Set<string>) : new Set(crossed);
  return levels.some((l) => marked.has(l.key) && isBeyond(price, l));
}

/** Fixed-notation decimal string with the given significant digits; never
 * exponent notation, since toBaseUnits rejects it. */
export function toSignificant(value: number, digits: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`toSignificant: expected a positive finite number, got ${value}`);
  }
  const precise = value.toPrecision(digits);
  const eIndex = precise.toLowerCase().indexOf('e');
  const expanded = eIndex < 0 ? precise : expandExponential(precise, eIndex);
  return trimTrailingZeros(expanded);
}

function expandExponential(s: string, eIndex: number): string {
  const mantissa = s.slice(0, eIndex);
  const exp = Number(s.slice(eIndex + 1));
  const dot = mantissa.indexOf('.');
  const digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  const intLen = (dot < 0 ? mantissa.length : dot) + exp;
  if (intLen <= 0) return '0.' + '0'.repeat(-intLen) + digits;
  if (intLen >= digits.length) return digits + '0'.repeat(intLen - digits.length);
  return digits.slice(0, intLen) + '.' + digits.slice(intLen);
}

function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * The largest clip that can actually trade. A fixed clip strands the agent the
 * moment the wallet holds a hair less than it: the balance guard blocks every
 * crossing forever while the capital sits idle. So take the desired size when
 * the wallet affords it, otherwise fall back to the whole affordable balance
 * while that still clears minUsd, otherwise 0 meaning this leg cannot fund even
 * the floor and must block.
 *
 * ONLY EVER SHRINKS: the result is never above desiredUsd, which is what makes
 * this risk-reducing rather than a change of strategy. Every breaker, cooldown,
 * cap and halt is untouched and still decides whether the clip trades at all.
 */
export function effectiveClipUsd(
  desiredUsd: number,
  affordableUsd: number,
  minUsd = MIN_CLIP_USD,
): number {
  if (!Number.isFinite(affordableUsd) || affordableUsd <= 0) return 0;
  if (affordableUsd >= desiredUsd) return desiredUsd;
  return affordableUsd >= minUsd ? affordableUsd : 0;
}

/** Notional clip: buys spend clipUsd USDT; sells move clipUsd/price WBNB
 * quoted to 6 significant digits. */
export function clipForLevel(
  side: GridSide,
  price: number,
  clipUsd = CLIP_USD,
): { token: 'WBNB' | 'USDT'; amount: string } {
  if (side === 'buy') return { token: 'USDT', amount: String(clipUsd) };
  return { token: 'WBNB', amount: toSignificant(clipUsd / price, 6) };
}

export function inventoryValueUsd(wbnbWhole: number, usdtWhole: number, price: number): number {
  return wbnbWhole * price + usdtWhole;
}

export function isCooldownActive(
  nowMs: number,
  lastFillAtMs: number | null,
  cooldownMs = COOLDOWN_MS,
): boolean {
  return lastFillAtMs !== null && nowMs - lastFillAtMs < cooldownMs;
}

/** Breakout is strictly greater than the cap; exactly 6 percent still trades.
 * Formulated without division: price/center - 1 carries a float artifact that
 * pushes the exact boundary over the cap. */
export function isTrendBreakout(
  price: number,
  center: number,
  maxDeviation = TREND_MAX_DEVIATION,
): boolean {
  return price > center * (1 + maxDeviation) || price < center * (1 - maxDeviation);
}

/** Breach is strictly below the floor; exactly 95 percent still trades. */
export function isLossBreach(
  inventoryNowUsd: number,
  inventoryStartUsd: number,
  floor = LOSS_FLOOR_FRACTION,
): boolean {
  return inventoryNowUsd < inventoryStartUsd * floor;
}

export type GuardFailure =
  | 'cooldown'
  | 'rate-limit'
  | 'trend-breakout'
  | 'daily-loss'
  | 'insufficient-balance';

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

export type GuardResult = { ok: true } | { ok: false; reason: GuardFailure; halt: boolean };

/** Guard order: HALTING conditions first (daily loss, then trend breakout) so
 * they always trip regardless of cooldown or a spent rate-limit budget, then
 * the non-halting gates (cooldown, rate limit, balance). halt true means the
 * caller must trip the breaker. Note: allowTrade() records a slot, so it is
 * evaluated only after the halts and cooldown have passed, never burning the
 * daily budget on a no-op tick. */
export function evaluateGuards(input: GuardInput): GuardResult {
  // Capital protection before adaptation: daily loss halts first, so it wins
  // when a downward move is both a loss breach and a breakout.
  if (isLossBreach(input.inventoryNowUsd, input.inventoryStartUsd, input.lossFloor)) {
    return { ok: false, reason: 'daily-loss', halt: true };
  }
  if (isTrendBreakout(input.price, input.center, input.maxDeviation)) {
    return { ok: false, reason: 'trend-breakout', halt: true };
  }
  if (isCooldownActive(input.nowMs, input.lastFillAtMs, input.cooldownMs)) {
    return { ok: false, reason: 'cooldown', halt: false };
  }
  if (input.balanceBaseUnits < input.clipBaseUnits) {
    return { ok: false, reason: 'insufficient-balance', halt: false };
  }
  if (!input.allowTrade()) {
    return { ok: false, reason: 'rate-limit', halt: false };
  }
  return { ok: true };
}

/* ----------------------------- chain access ----------------------------- */

interface ReferencePool {
  address: `0x${string}`;
  fee: number;
  wbnbIsToken0: boolean;
}

async function resolveReferencePool(ctx: AgentContext): Promise<ReferencePool> {
  const cached = ctx.state.get<ReferencePool | null>('referencePool', null);
  if (cached) return cached;

  let best: { pool: ReferencePool; liquidity: bigint } | null = null;
  for (const fee of FEE_TIERS) {
    const address = await ctx.publicClient.readContract({
      address: PANCAKE_V3_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [WBNB.address, USDT.address, fee],
    });
    if (address.toLowerCase() === ZERO_ADDRESS) continue;
    const [token0, token1, poolFee, liquidity] = await Promise.all([
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'token0' }),
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'token1' }),
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'fee' }),
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'liquidity' }),
    ]);
    const pair = [token0.toLowerCase(), token1.toLowerCase()].sort().join('/');
    const expected = [WBNB.address.toLowerCase(), USDT.address.toLowerCase()].sort().join('/');
    if (pair !== expected || poolFee !== fee) {
      ctx.log({ event: 'pool-mismatch', address, fee, token0, token1, poolFee });
      continue;
    }
    ctx.log({ event: 'pool-probe', address, fee, liquidity: liquidity.toString() });
    const pool: ReferencePool = {
      address,
      fee,
      wbnbIsToken0: token0.toLowerCase() === WBNB.address.toLowerCase(),
    };
    if (!best || liquidity > best.liquidity) best = { pool, liquidity };
  }
  if (!best) throw new Error('no valid WBNB/USDT PancakeSwap V3 pool found via factory');
  ctx.state.set('referencePool', best.pool);
  ctx.log({ event: 'pool-selected', ...best.pool, liquidity: best.liquidity.toString() });
  return best.pool;
}

async function readMidPrice(ctx: AgentContext, pool: ReferencePool): Promise<number> {
  const slot0 = await ctx.publicClient.readContract({
    address: pool.address,
    abi: POOL_ABI,
    functionName: 'slot0',
  });
  return priceFromSqrtPriceX96(slot0[0], pool.wbnbIsToken0);
}

async function readBalances(ctx: AgentContext): Promise<{ wbnb: bigint; usdt: bigint }> {
  const [wbnb, usdt] = await Promise.all([
    ctx.publicClient.readContract({
      address: WBNB.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ctx.account.address],
    }),
    ctx.publicClient.readContract({
      address: USDT.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ctx.account.address],
    }),
  ]);
  return { wbnb, usdt };
}

/** Why the grid re-armed: a breakout out of the band, or a stale center the
 * market no longer reaches. Both spend the SAME daily budget. */
export type RecenterReason = 'breakout' | 'stale';

/**
 * Re-center the grid on the current price (fresh center, cleared level marks,
 * PRESERVED loss baseline) so it keeps trading around the live price instead of
 * going quiet forever. Returns false when the daily re-center budget is spent.
 *
 * THE ONLY re-center path, and the only consumer of the 'recenter' action
 * counter, so a breakout re-center and a stale re-center draw on one shared
 * MAX_RECENTERS_PER_DAY allowance and can never together exceed it. Breakout is
 * checked earlier in the tick than staleness, so on a tick where both apply the
 * acute case takes the budget first. The daily-loss breaker still protects
 * capital across re-centers.
 */
export function maybeRecenter(
  ctx: AgentContext,
  price: number,
  inventoryNowUsd: number,
  reason: RecenterReason = 'breakout',
  detail: Record<string, unknown> = {},
): boolean {
  if (!ctx.breakers.allowAction('recenter', MAX_RECENTERS_PER_DAY)) return false;
  const previousCenter = ctx.state.get<number | null>('center', null);
  ctx.state.set('center', price);
  ctx.state.set('lastPrice', price);
  ctx.state.set('crossedLevels', []);
  // Deliberately NOT resetting inventoryStartUsd: the drawdown floor stays
  // anchored to the original baseline so cumulative loss across re-centers is
  // still capped, rather than each re-center granting a fresh 5% of rope.
  ctx.log({
    event: 'grid-recenter',
    reason,
    previousCenter,
    center: price,
    inventoryNowUsd,
    ...detail,
  });
  return true;
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
      { sellToken, buyToken, sellAmount: clip.amount, slippageBps: SLIPPAGE_BPS },
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
