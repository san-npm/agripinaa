/**
 * Surplus math over CoW orders, ported from the Ophis frontend receipt
 * service (mevReceipt/services/buildReceipt.ts) and generalized to both
 * order kinds. All arithmetic is bigint; the only float produced is the
 * final bps figure.
 *
 * Sell order: surplus = executedBuyAmount - buyAmount, in buy-token units.
 * Buy order: surplus = sellAmount - executedSellAmountBeforeFees, in sell-token units.
 * For partial fills the signed limit is scaled to the filled fraction so a
 * half-filled order is not reported as negative surplus; on a full fill the
 * scaled limit equals the signed limit and the formulas above hold exactly.
 */

import { fromBaseUnits, TOKENS_BSC } from '@agripinaa/shared';

import type { CowOrder } from './cow';

// BigInt() calls instead of literals: consumers typecheck this source at
// whatever target their toolchain applies (Next.js pins one below ES2020).
const BIGINT_ZERO = BigInt(0);

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
  | 'executedSellAmountBeforeFees'
  | 'executedFeeAmount'
>;

function toBigInt(value: string | undefined): bigint | null {
  // API amounts are uint256 decimal strings. Missing or malformed is not zero.
  if (typeof value !== 'string' || !/^[0-9]{1,78}$/.test(value)) return null;
  const amount = BigInt(value);
  return amount < BigInt(2) ** BigInt(256) ? amount : null;
}

/** Exact rational surplus; do not round the partial-fill limit before division. */
function surplusFraction(order: SurplusOrder) {
  const sell = toBigInt(order.sellAmount);
  const buy = toBigInt(order.buyAmount);
  const grossSell = toBigInt(order.executedSellAmount);
  const execBuy = toBigInt(order.executedBuyAmount);
  const fee = toBigInt(order.executedFeeAmount ?? '0');
  const execSell = order.executedSellAmountBeforeFees !== undefined
    ? toBigInt(order.executedSellAmountBeforeFees)
    : grossSell !== null && fee !== null ? grossSell - fee : null;
  if (sell === null || buy === null || grossSell === null || execBuy === null || fee === null || execSell === null
    || sell <= BIGINT_ZERO || buy <= BIGINT_ZERO || execSell <= BIGINT_ZERO || execBuy <= BIGINT_ZERO
    || execSell > grossSell || (order.executedFeeAmount !== undefined && execSell + fee !== grossSell)) return null;
  if (order.kind === 'sell') {
    return { numerator: execBuy * sell - buy * execSell, limit: buy * execSell, scale: sell };
  }
  if (order.kind === 'buy') {
    return { numerator: sell * execBuy - execSell * buy, limit: sell * execBuy, scale: buy };
  }
  return null;
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
 * Fractional base units are rounded down, so raw surplus never overstates
 * the result. BPS uses the exact fraction, not this rounded token amount.
 */
export function calcSurplusRaw(order: SurplusOrder): bigint | null {
  const fraction = surplusFraction(order);
  if (!fraction) return null;
  const { numerator, scale } = fraction;
  return numerator >= BIGINT_ZERO ? numerator / scale : -((-numerator + scale - BigInt(1)) / scale);
}

/**
 * Fractional surplus vs the signed limit, excluding the separately signed
 * fee on both sides of the comparison. Embedded execution fees remain in the
 * executed amounts. This is NOT improvement against a market quote or profit.
 * Shares the same basis as the BPS display and receipt.
 */
export function surplusRatio(order: SurplusOrder): number | null {
  const bps = surplusBps(order);
  return bps === null ? null : bps / 10_000;
}

/** One basis point is 1/10,000. Retain 12 BPS decimals until UI rounding. */
export function surplusBps(order: SurplusOrder): number | null {
  const fraction = surplusFraction(order);
  if (!fraction) return null;
  return Number(fraction.numerator * BigInt('10000000000000000') / fraction.limit) / 1e12;
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
    totalSurplusRaw[token] = (totalSurplusRaw[token] ?? BIGINT_ZERO) + raw;

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
  const sign = raw < BIGINT_ZERO ? '-' : '';
  const amount = fromBaseUnits(raw < BIGINT_ZERO ? -raw : raw, decimals);
  return known ? `${sign}${amount} ${known.symbol}` : `${sign}${amount}`;
}
