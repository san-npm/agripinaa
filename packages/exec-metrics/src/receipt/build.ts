/**
 * Headless port of the Ophis frontend MEV-proof receipt builder
 * (mevReceipt/services/buildReceipt.ts). Keeps the MevProofReceipt v3 shape
 * with two deliberate deltas:
 *   1. pathVizSvgBase64 is omitted (the path visualization backend is
 *      Optimism-only and never applies to BSC settlements).
 *   2. partnerFee is parsed from the order's own fullAppData metadata rather
 *      than filtered against a hardcoded Ophis recipient constant, and ALL
 *      decodable entries are kept (metadata.partnerFee may be a single object
 *      or an array of stacked entries).
 */

import type { CowOrder, CowTrade } from '../cow';

// BigInt() call instead of a literal: consumers typecheck this source at
// whatever target their toolchain applies (Next.js pins one below ES2020).
const BIGINT_ZERO = BigInt(0);

/**
 * CIP-75 partner-fee config baked into the order's appData. Only the two
 * models Ophis emits are decoded (flat volume, legacy priceImprovement);
 * CIP-75's surplus and tiered-array models decode to nothing rather than
 * being guessed at.
 */
export type PartnerFeeInfo =
  | {
      readonly type: 'priceImprovement';
      /** Share of execution beating the quote, in bps. */
      readonly priceImprovementBps: number;
      /** Ceiling on the fee as a fraction of volume, in bps. */
      readonly maxVolumeBps: number;
      readonly recipient: string;
    }
  | {
      readonly type: 'volume';
      /** Flat fee as a fraction of trade volume, in bps. */
      readonly volumeBps: number;
      readonly recipient: string;
    };

export interface MevProofReceipt {
  /** CoW order UID (0x-prefixed hex). */
  readonly orderUid: string;
  readonly chainId: number;
  readonly owner: string;
  readonly sellToken: string;
  readonly buyToken: string;
  /** Signed sellAmount, base units. */
  readonly sellAmount: string;
  /** Signed buyAmount limit, base units. */
  readonly buyAmount: string;
  readonly executedSellAmount: string;
  readonly executedBuyAmount: string;
  /** Unix seconds. */
  readonly validTo: number;
  readonly settlementTxHash: string | null;
  readonly settlementBlock: number | null;
  readonly status: string;
  /** Every decodable partner-fee entry from appData; empty when none. */
  readonly partnerFee: readonly PartnerFeeInfo[];
  /** Fractional improvement over the signed limit; null when not settled. */
  readonly surplusVsQuote: number | null;
  readonly receiptVersion: '3';
  /** ISO-8601 UTC timestamp of receipt creation. */
  readonly generatedAt: string;
}

export interface BuildReceiptInput {
  readonly order: CowOrder;
  readonly trade: CowTrade | null;
  readonly chainId: number;
}

type PartnerFeeRecord = Record<string, unknown> & { recipient: string };

function asPartnerFeeRecord(value: unknown): PartnerFeeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.recipient === 'string' ? (record as PartnerFeeRecord) : null;
}

function decodePartnerFee(record: PartnerFeeRecord): PartnerFeeInfo | null {
  // priceImprovement is checked first: a PI entry carries no volumeBps, so
  // the volume branch would misread it as undecodable.
  if (typeof record.priceImprovementBps === 'number' && typeof record.maxVolumeBps === 'number') {
    return {
      type: 'priceImprovement',
      priceImprovementBps: record.priceImprovementBps,
      maxVolumeBps: record.maxVolumeBps,
      recipient: record.recipient,
    };
  }
  // Older appData versions spelled volumeBps as "bps".
  const volumeBps = record.volumeBps ?? record.bps;
  return typeof volumeBps === 'number' ? { type: 'volume', volumeBps, recipient: record.recipient } : null;
}

/** Normalizes metadata.partnerFee (object or array) to the decodable entries, keeping all of them. */
export function extractPartnerFees(fullAppData: string | null): PartnerFeeInfo[] {
  if (!fullAppData) return [];
  try {
    const parsed = JSON.parse(fullAppData) as { metadata?: { partnerFee?: unknown } };
    const raw = parsed.metadata?.partnerFee;
    const entries = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    const decoded: PartnerFeeInfo[] = [];
    for (const entry of entries) {
      const record = asPartnerFeeRecord(entry);
      if (!record) continue;
      const fee = decodePartnerFee(record);
      if (fee) decoded.push(fee);
    }
    return decoded;
  } catch {
    return [];
  }
}

/**
 * Fractional surplus versus the signed limit: (executed - limit) / limit in
 * the buy token for sells, (limit - executed) / limit in the sell token for
 * buys. Floats are acceptable here, the field is a display ratio; exact
 * accounting lives in surplus.ts.
 */
function calcSurplusVsQuote(order: CowOrder): number | null {
  const executed = order.kind === 'sell' ? order.executedBuyAmount : order.executedSellAmount;
  const limit = order.kind === 'sell' ? order.buyAmount : order.sellAmount;
  if (!executed || executed === '0' || !limit || limit === '0') return null;
  let exec: bigint;
  let lim: bigint;
  try {
    exec = BigInt(executed);
    lim = BigInt(limit);
  } catch {
    return null;
  }
  if (lim === BIGINT_ZERO) return null;
  const diff = order.kind === 'sell' ? exec - lim : lim - exec;
  return Number(diff) / Number(lim);
}

export function buildReceipt({ order, trade, chainId }: BuildReceiptInput): MevProofReceipt {
  return {
    orderUid: order.uid,
    chainId,
    owner: order.owner,
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    executedSellAmount: order.executedSellAmount,
    executedBuyAmount: order.executedBuyAmount,
    validTo: order.validTo,
    settlementTxHash: trade?.txHash ?? null,
    settlementBlock: trade?.blockNumber ?? null,
    status: order.status,
    partnerFee: extractPartnerFees(order.fullAppData),
    surplusVsQuote: trade ? calcSurplusVsQuote(order) : null,
    receiptVersion: '3',
    generatedAt: new Date().toISOString(),
  };
}
