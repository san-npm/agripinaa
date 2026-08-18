/**
 * Grid: WBNB/USDT mean-reversion grid on BSC. Price reference is the deepest
 * PancakeSwap V3 WBNB/USDT pool; execution is Ophis (CoW) swaps only.
 * Four levels each side of the first-tick center at 1.5 percent spacing,
 * $2 clips, hard halts on a 6 percent trend breakout or a 5 percent
 * inventory drawdown. All sizing comes from live balances every tick.
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
export const CLIP_USD = 2;
export const COOLDOWN_MS = 10 * 60_000;
export const MAX_TRADES_PER_DAY = 12;
export const TREND_MAX_DEVIATION = 0.06;
export const LOSS_FLOOR_FRACTION = 0.95;
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

/** All marks clear once price returns to within half a grid step of center,
 * boundary inclusive. Formulated without division to keep the exact boundary
 * free of float artifacts. */
export function unmarkNearCenter(
  price: number,
  center: number,
  crossed: string[],
  spacing = GRID_SPACING,
): string[] {
  if (crossed.length === 0) return crossed;
  return Math.abs(price - center) <= center * (spacing / 2) ? [] : crossed;
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

/** $2 notional clip: buys spend a fixed '2' USDT; sells move 2/price WBNB
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

/** Spec-fixed guard order: cooldown, rate limit, trend halt, loss halt,
 * balance sufficiency. halt true means the caller must trip the breaker. */
export function evaluateGuards(input: GuardInput): GuardResult {
  if (isCooldownActive(input.nowMs, input.lastFillAtMs, input.cooldownMs)) {
    return { ok: false, reason: 'cooldown', halt: false };
  }
  if (!input.allowTrade()) {
    return { ok: false, reason: 'rate-limit', halt: false };
  }
  if (isTrendBreakout(input.price, input.center, input.maxDeviation)) {
    return { ok: false, reason: 'trend-breakout', halt: true };
  }
  if (isLossBreach(input.inventoryNowUsd, input.inventoryStartUsd, input.lossFloor)) {
    return { ok: false, reason: 'daily-loss', halt: true };
  }
  if (input.balanceBaseUnits < input.clipBaseUnits) {
    return { ok: false, reason: 'insufficient-balance', halt: false };
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

    const storedCenter = ctx.state.get<number | null>('center', null);
    if (storedCenter === null) {
      ctx.state.set('center', price);
      ctx.state.set('inventoryStartUsd', inventoryNowUsd);
      ctx.state.set('lastPrice', price);
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
    const inventoryStartUsd = ctx.state.get<number>('inventoryStartUsd', inventoryNowUsd);
    const prevPrice = ctx.state.get<number>('lastPrice', price);
    ctx.state.set('lastPrice', price);

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
      // With every level already marked the guard chain below is never
      // reached, so the breakout and drawdown breakers must also fire here
      // or a runaway trend would leave the agent unprotected.
      if (isTrendBreakout(price, center)) {
        ctx.log({ event: 'trend-breakout', price, center });
        ctx.breakers.halt('trend-breakout');
        return;
      }
      if (isLossBreach(inventoryNowUsd, inventoryStartUsd)) {
        ctx.log({ event: 'daily-loss', inventoryNowUsd, inventoryStartUsd });
        ctx.breakers.halt('daily-loss');
        return;
      }
      ctx.log({ event: 'tick', price, center, inventoryNowUsd, crossedCount: crossed.length });
      return;
    }

    const clip = clipForLevel(hit.level.side, price);
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
    });

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
    ctx.state.set('lastFillAt', Date.now());
    ctx.state.set('crossedLevels', [...crossed, hit.level.key]);
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
