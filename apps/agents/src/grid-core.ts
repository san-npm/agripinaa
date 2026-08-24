/**
 * The shared grid core.
 *
 * Two agents run this strategy: `grid` on WBNB/USDT and `grid-b` on WBNB/USDC,
 * with different spacing, clips, cooldowns and daily caps. Everything that
 * decides WHAT a grid does, the ladder geometry, crossing detection, clip
 * sizing, the guard chain, the re-center rule, and the pool, price and balance
 * reads that feed them, lives here once and is parameterised. Each agent module
 * keeps its own constants, its own tick wiring, and its own persisted state.
 *
 * NOTHING HERE HAS A DEFAULT. Every parameter is passed in by the calling
 * module, so one grid can never silently inherit the other's spacing, clip,
 * cooldown or halt band. `grid.ts` re-exports these behind its own constants,
 * which is why its public API and its behaviour are unchanged by the
 * extraction: the arithmetic below is the arithmetic it already shipped, moved
 * rather than rewritten.
 */
import type { TokenInfo } from '@agripinaa/shared';
import { erc20Abi, parseAbi } from 'viem';

import type { AgentContext } from './types';

export type GridSide = 'buy' | 'sell';

export interface GridLevel {
  key: string;
  side: GridSide;
  /** 1 is nearest to center, levelsPerSide is farthest. */
  index: number;
  price: number;
}

export interface FillRecord {
  at: string;
  side: GridSide;
  level: string;
  clipToken: string;
  clipAmount: string;
  price: number;
  orderUid: string;
}

/**
 * One grid's parameter set, in the units a manifest publishes them in
 * (percentages, not fractions), so the served safety caps and the numbers the
 * agent actually enforces are the same values rather than two transcriptions.
 */
export interface GridParams {
  /** Display pair, base first: "WBNB/USDC". */
  pair: string;
  /** Distance between levels, in percent of center. */
  spacingPct: number;
  levelsPerSide: number;
  /** Desired clip in USD; the traded clip only ever shrinks from here. */
  clipUsd: number;
  /** Floor for a shrunk clip: below this a leg cannot trade at all. */
  minClipUsd: number;
  /** Must exceed the Ophis order validity, or clips can overlap in flight. */
  cooldownMs: number;
  maxTradesPerDay: number;
  maxRecentersPerDay: number;
  /** Breakout halt band, in percent either side of center. */
  trendHaltBandPct: number;
  /** Inventory drawdown halt, in percent below the baseline. */
  lossHaltPct: number;
  /** Drought after which a drifted center counts as stale. */
  staleRecenterMs: number;
}

/** Level spacing as a fraction. */
export function spacingOf(params: GridParams): number {
  return params.spacingPct / 100;
}

/** Breakout band as a fraction. */
export function trendBandOf(params: GridParams): number {
  return params.trendHaltBandPct / 100;
}

/** Drawdown floor as a fraction of the baseline (5 percent loss -> 0.95). */
export function lossFloorOf(params: GridParams): number {
  return 1 - params.lossHaltPct / 100;
}

/* ------------------------------ pure logic ------------------------------ */

export function computeLevels(center: number, spacing: number, perSide: number): GridLevel[] {
  const levels: GridLevel[] = [];
  for (let i = 1; i <= perSide; i++) {
    levels.push({ key: `sell:${i}`, side: 'sell', index: i, price: center * (1 + spacing * i) });
  }
  for (let i = 1; i <= perSide; i++) {
    levels.push({ key: `buy:${i}`, side: 'buy', index: i, price: center * (1 - spacing * i) });
  }
  return levels;
}

/** The ladder as two ordered price lists: buys away from center descending,
 * sells away from center ascending. Same geometry computeLevels produces,
 * shaped for callers that want the rungs rather than the level records. */
export function buildLadder(
  center: number,
  params: GridParams,
): { buys: number[]; sells: number[] } {
  const levels = computeLevels(center, spacingOf(params), params.levelsPerSide);
  const byIndex = (a: GridLevel, b: GridLevel) => a.index - b.index;
  return {
    buys: levels.filter((l) => l.side === 'buy').sort(byIndex).map((l) => l.price),
    sells: levels.filter((l) => l.side === 'sell').sort(byIndex).map((l) => l.price),
  };
}

/**
 * Quote per base from slot0. Valid only where both tokens carry the same number
 * of decimals, which is why resolveReferencePool refuses a pair that does not:
 * the raw sqrt ratio would otherwise need a 10^(d0-d1) correction.
 */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, baseIsToken0: boolean): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = ratio * ratio;
  return baseIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
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
export function isWithinUnmarkBand(price: number, center: number, spacing: number): boolean {
  return Math.abs(price - center) <= center * (spacing / 2);
}

/** All marks clear once price returns to within half a grid step of center,
 * boundary inclusive. */
export function unmarkNearCenter(
  price: number,
  center: number,
  crossed: string[],
  spacing: number,
): string[] {
  if (crossed.length === 0) return crossed;
  return isWithinUnmarkBand(price, center, spacing) ? [] : crossed;
}

/**
 * A center the market has left behind silences the grid permanently. Marks only
 * clear inside the un-mark band, so once price settles between two levels with
 * the near one marked, there is nothing left to trade and nothing that can
 * un-mark it: the only escape is a breakout the range will never reach.
 * Staleness names exactly that shape, a long drought while price sits where no
 * mark can clear, and is the signal to re-arm around the live price.
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
  staleMs: number,
  spacing: number,
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
 * grid that is merely waiting for one step of movement; re-centering there
 * resets the distance to the nearest level from as little as half a step back
 * to a full step, pushing the next fill FURTHER away. Replaying the real BNB
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
  minUsd: number,
): number {
  if (!Number.isFinite(affordableUsd) || affordableUsd <= 0) return 0;
  if (affordableUsd >= desiredUsd) return desiredUsd;
  return affordableUsd >= minUsd ? affordableUsd : 0;
}

/** Notional clip: buys spend clipUsd of the quote token; sells move
 * clipUsd/price of the base token, quoted to 6 significant digits. */
export function clipForLevel<B extends string, Q extends string>(
  side: GridSide,
  price: number,
  clipUsd: number,
  symbols: { base: B; quote: Q },
): { token: B | Q; amount: string } {
  if (side === 'buy') return { token: symbols.quote, amount: String(clipUsd) };
  return { token: symbols.base, amount: toSignificant(clipUsd / price, 6) };
}

/** Both legs valued in the quote token, which is a dollar stablecoin on both
 * grids, so the sum is the inventory in USD. */
export function inventoryValueUsd(baseWhole: number, quoteWhole: number, price: number): number {
  return baseWhole * price + quoteWhole;
}

export function isCooldownActive(
  nowMs: number,
  lastFillAtMs: number | null,
  cooldownMs: number,
): boolean {
  return lastFillAtMs !== null && nowMs - lastFillAtMs < cooldownMs;
}

/** Breakout is strictly greater than the cap; exactly at the band still trades.
 * Formulated without division: price/center - 1 carries a float artifact that
 * pushes the exact boundary over the cap. */
export function isTrendBreakout(price: number, center: number, maxDeviation: number): boolean {
  return price > center * (1 + maxDeviation) || price < center * (1 - maxDeviation);
}

/** Breach is strictly below the floor; exactly at the floor still trades. */
export function isLossBreach(
  inventoryNowUsd: number,
  inventoryStartUsd: number,
  floor: number,
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
  cooldownMs: number;
  maxDeviation: number;
  lossFloor: number;
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
 * allowance and can never together exceed it. Breakout is checked earlier in
 * the tick than staleness, so on a tick where both apply the acute case takes
 * the budget first. The daily-loss breaker still protects capital across
 * re-centers.
 */
export function maybeRecenter(
  ctx: AgentContext,
  price: number,
  inventoryNowUsd: number,
  maxRecentersPerDay: number,
  reason: RecenterReason = 'breakout',
  detail: Record<string, unknown> = {},
): boolean {
  if (!ctx.breakers.allowAction('recenter', maxRecentersPerDay)) return false;
  const previousCenter = ctx.state.get<number | null>('center', null);
  ctx.state.set('center', price);
  ctx.state.set('lastPrice', price);
  ctx.state.set('crossedLevels', []);
  // Deliberately NOT resetting inventoryStartUsd: the drawdown floor stays
  // anchored to the original baseline so cumulative loss across re-centers is
  // still capped, rather than each re-center granting a fresh slice of rope.
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

/* ----------------------------- chain access ----------------------------- */

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
export const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as const;

/**
 * The tiers a grid will consider. Deliberately excludes fee 10000, whose
 * WBNB/USDT book holds about $14: a reference pool that shallow is cheap to
 * skew, and the price read here is what every level and halt is measured
 * against.
 */
export const FEE_TIERS = [100, 500, 2500] as const;

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

/** The two sides of a grid, base first (the token whose price is quoted). */
export interface GridPair {
  base: TokenInfo;
  quote: TokenInfo;
  feeTiers?: readonly number[];
}

export interface ReferencePool {
  address: `0x${string}`;
  fee: number;
  /**
   * Whether the BASE token is token0. The field keeps its original name because
   * the live grid agent has this object persisted under state key
   * `referencePool`; a rename would read back as undefined on the next boot and
   * silently invert the price. Both grids quote WBNB, so the name is accurate.
   */
  wbnbIsToken0: boolean;
}

/**
 * Resolve the deepest valid pool for the pair through the factory, and cache
 * it. Validates the token pair and the fee tier the pool reports before it is
 * eligible, so neither a stale address nor a factory answer for the wrong book
 * can be traded against.
 */
export async function resolveReferencePool(
  ctx: AgentContext,
  pair: GridPair,
): Promise<ReferencePool> {
  const cached = ctx.state.get<ReferencePool | null>('referencePool', null);
  if (cached) return cached;

  // priceFromSqrtPriceX96 reads the raw slot0 ratio with no decimal
  // correction, which is only right when both sides carry the same decimals
  // (they do for WBNB/USDT and WBNB/USDC on BSC, all 18). Refuse rather than
  // quote a price that is wrong by a power of ten.
  if (pair.base.decimals !== pair.quote.decimals) {
    throw new Error(
      `grid pair ${pair.base.symbol}/${pair.quote.symbol} mixes decimals (${pair.base.decimals}/${pair.quote.decimals}); the slot0 price would need scaling`,
    );
  }

  let best: { pool: ReferencePool; liquidity: bigint } | null = null;
  for (const fee of pair.feeTiers ?? FEE_TIERS) {
    const address = await ctx.publicClient.readContract({
      address: PANCAKE_V3_FACTORY,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [pair.base.address, pair.quote.address, fee],
    });
    if (address.toLowerCase() === ZERO_ADDRESS) continue;
    const [token0, token1, poolFee, liquidity] = await Promise.all([
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'token0' }),
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'token1' }),
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'fee' }),
      ctx.publicClient.readContract({ address, abi: POOL_ABI, functionName: 'liquidity' }),
    ]);
    const found = [token0.toLowerCase(), token1.toLowerCase()].sort().join('/');
    const expected = [pair.base.address.toLowerCase(), pair.quote.address.toLowerCase()]
      .sort()
      .join('/');
    if (found !== expected || poolFee !== fee) {
      ctx.log({ event: 'pool-mismatch', address, fee, token0, token1, poolFee });
      continue;
    }
    ctx.log({ event: 'pool-probe', address, fee, liquidity: liquidity.toString() });
    const pool: ReferencePool = {
      address,
      fee,
      wbnbIsToken0: token0.toLowerCase() === pair.base.address.toLowerCase(),
    };
    if (!best || liquidity > best.liquidity) best = { pool, liquidity };
  }
  if (!best) {
    throw new Error(
      `no valid ${pair.base.symbol}/${pair.quote.symbol} PancakeSwap V3 pool found via factory`,
    );
  }
  ctx.state.set('referencePool', best.pool);
  ctx.log({ event: 'pool-selected', ...best.pool, liquidity: best.liquidity.toString() });
  return best.pool;
}

export async function readMidPrice(ctx: AgentContext, pool: ReferencePool): Promise<number> {
  const slot0 = await ctx.publicClient.readContract({
    address: pool.address,
    abi: POOL_ABI,
    functionName: 'slot0',
  });
  return priceFromSqrtPriceX96(slot0[0], pool.wbnbIsToken0);
}

/** Wallet balances of both legs, in base units. */
export async function readBalances(
  ctx: AgentContext,
  pair: GridPair,
): Promise<{ base: bigint; quote: bigint }> {
  const [base, quote] = await Promise.all([
    ctx.publicClient.readContract({
      address: pair.base.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ctx.account.address],
    }),
    ctx.publicClient.readContract({
      address: pair.quote.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ctx.account.address],
    }),
  ]);
  return { base, quote };
}
