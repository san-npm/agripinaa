/**
 * Surplus math over CoW orders, ported from the Ophis frontend receipt
 * service (mevReceipt/services/buildReceipt.ts) and generalized to both
 * order kinds. All arithmetic is bigint; the only float produced is the
 * final bps figure.
 *
 * Sell order: surplus = executedBuyAmount - buyAmount, in buy-token units.
 * Buy order: surplus = sellAmount - executedSellAmount, in sell-token units.
 * For partial fills the signed limit is scaled to the filled fraction so a
 * half-filled order is not reported as negative surplus; on a full fill the
 * scaled limit equals the signed limit and the formulas above hold exactly.
 */

import { fromBaseUnits, TOKENS_BSC } from '@agripinaa/shared';

import type { CowOrder } from './cow';

export type SurplusOrder = Pick<
  CowOrder,
  | 'kind'
  | 'status'
  | 'sellToken'
  | 'buyToken'
  | 'sellAmount'
  | 'buyAmount'
  | 'executedSellAmount'
  | 'executedBuyAmount'
>;

function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Token address the surplus is denominated in: buy token for sells, sell token for buys. */
export function surplusToken(order: Pick<SurplusOrder, 'kind' | 'sellToken' | 'buyToken'>): string {
  return order.kind === 'sell' ? order.buyToken : order.sellToken;
}

/**
 * Raw surplus in base units of surplusToken(order), or null when nothing
 * executed (open, expired, cancelled without fill) or the signed amounts are
 * degenerate (zero, which would divide by zero when scaling).
 *
 * Scaled-limit division floors, which can overstate sell-order surplus and
 * understate buy-order surplus by at most 1 wei on partial fills.
 */
export function calcSurplusRaw(order: SurplusOrder): bigint | null {
  const sell = toBigInt(order.sellAmount);
  const buy = toBigInt(order.buyAmount);
  const execSell = toBigInt(order.executedSellAmount);
  const execBuy = toBigInt(order.executedBuyAmount);

  if (order.kind === 'sell') {
    if (execSell === 0n || sell === 0n) return null;
    const scaledLimitBuy = (buy * execSell) / sell;
    return execBuy - scaledLimitBuy;
  }

  if (execBuy === 0n || buy === 0n) return null;
  const scaledLimitSell = (sell * execBuy) / buy;
  return scaledLimitSell - execSell;
}

/**
 * Surplus relative to the signed limit amount, in basis points with two
 * decimals of precision. For partial fills the limit is scaled to the filled
 * fraction (identical to the signed limit on a full fill). Null when
 * calcSurplusRaw is null or the limit is zero.
 */
export function surplusBps(order: SurplusOrder): number | null {
  const raw = calcSurplusRaw(order);
  if (raw === null) return null;

  const sell = toBigInt(order.sellAmount);
  const buy = toBigInt(order.buyAmount);
  const execSell = toBigInt(order.executedSellAmount);
  const execBuy = toBigInt(order.executedBuyAmount);

  const limit = order.kind === 'sell' ? (buy * execSell) / sell : (sell * execBuy) / buy;
  if (limit <= 0n) return null;

  return Number((raw * 1_000_000n) / limit) / 100;
}

export interface SurplusSummary {
  totalOrders: number;
  /** Orders with status 'fulfilled'; only these contribute surplus. */
  filledOrders: number;
  /** Summed raw surplus per token, keyed by lowercased token address. */
  totalSurplusRaw: Record<string, bigint>;
  /** Mean surplusBps over fulfilled orders with a computable bps; null when none. */
  avgSurplusBps: number | null;
}

export function summarizeSurplus(orders: readonly SurplusOrder[]): SurplusSummary {
  const totalSurplusRaw: Record<string, bigint> = {};
  let filledOrders = 0;
  let bpsSum = 0;
  let bpsCount = 0;

  for (const order of orders) {
    if (order.status !== 'fulfilled') continue;
    filledOrders += 1;

    const raw = calcSurplusRaw(order);
    if (raw === null) continue;
    const token = surplusToken(order).toLowerCase();
    totalSurplusRaw[token] = (totalSurplusRaw[token] ?? 0n) + raw;

    const bps = surplusBps(order);
    if (bps !== null) {
      bpsSum += bps;
      bpsCount += 1;
    }
  }

  return {
    totalOrders: orders.length,
    filledOrders,
    totalSurplusRaw,
    avgSurplusBps: bpsCount > 0 ? bpsSum / bpsCount : null,
  };
}

/**
 * Human-readable surplus amount. Decimals come from the shared BNB Chain
 * token registry (USDT and USDC are 18 decimals there, not Ethereum's 6);
 * unknown tokens fall back to 18 and render without a symbol.
 */
export function formatSurplusAmount(tokenAddress: string, raw: bigint): string {
  const needle = tokenAddress.toLowerCase();
  const known = Object.values(TOKENS_BSC).find((t) => t.address.toLowerCase() === needle);
  const decimals = known?.decimals ?? 18;
  const sign = raw < 0n ? '-' : '';
  const amount = fromBaseUnits(raw < 0n ? -raw : raw, decimals);
  return known ? `${sign}${amount} ${known.symbol}` : `${sign}${amount}`;
}
