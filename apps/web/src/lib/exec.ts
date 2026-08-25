import 'server-only';

import { isAddress, keccak256, toBytes } from 'viem';
import {
  buildReceipt,
  CowOrderbookClient,
  isOphisOrder,
  summarizeSurplus,
  surplusBps,
  type CowOrder,
  type CowTrade,
  type MevProofReceipt,
  type SurplusSummary,
} from '@agripinaa/exec-metrics';
import { cacheLife } from 'next/cache';

const cow = new CowOrderbookClient();

export interface ExecOrderRow {
  uid: string;
  status: string;
  kind: string;
  sellToken: string;
  buyToken: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  surplusBps: number | null;
  creationDate: string;
  viaOphis: boolean;
}

export interface ExecSummary {
  owner: string;
  rows: ExecOrderRow[];
  summary: Omit<SurplusSummary, 'totalSurplusRaw'> & {
    totalSurplusRaw: Record<string, string>;
  };
  asOf: string;
}

/**
 * Execution history for one wallet, Ophis-attributed orders only (gated on
 * appCode in the order's appData, never the shared EIP-712 domain).
 */
export async function getExecutionSummary(owner: string): Promise<ExecSummary> {
  'use cache';
  cacheLife('minutes');
  // owner can be an agent's on-chain agentWallet, which is attacker-settable
  // metadata: validate before it reaches the upstream URL path or cache key.
  if (!isAddress(owner)) {
    return {
      owner,
      rows: [],
      summary: { totalOrders: 0, filledOrders: 0, avgSurplusBps: null, totalSurplusRaw: {} },
      asOf: new Date().toISOString(),
    };
  }
  const orders = await cow.getAccountOrders(owner as `0x${string}`, { limit: 100 });
  const ophisOrders = orders.filter((o) => isOphisOrder(o));
  const summary = summarizeSurplus(ophisOrders);
  return {
    owner,
    rows: ophisOrders.map((o) => ({
      uid: o.uid,
      status: o.status,
      kind: o.kind,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      executedSellAmount: o.executedSellAmount,
      executedBuyAmount: o.executedBuyAmount,
      surplusBps: surplusBps(o),
      creationDate: o.creationDate,
      viaOphis: true,
    })),
    summary: {
      ...summary,
      totalSurplusRaw: Object.fromEntries(
        Object.entries(summary.totalSurplusRaw).map(([token, raw]) => [
          token,
          raw.toString(),
        ]),
      ),
    },
    asOf: new Date().toISOString(),
  };
}

/**
 * One agent's cumulative settlement record, reduced to the four numbers a
 * reader compares across agents. Deliberately plain data: the leaderboard
 * ranks these side by side, so nothing page-specific belongs here.
 *
 * `fills` counts settled orders. The other three describe that set and are
 * null when it is empty, so a fresh agent reads as "nothing yet" rather than
 * as a zero-surplus one.
 */
export interface TrackRecord {
  fills: number;
  avgSurplusBps: number | null;
  /** Highest surplus of any single fill, which can be negative. */
  bestFillBps: number | null;
  /** ISO timestamp of the earliest fill, the start of the record. */
  firstSeen: string | null;
}

/**
 * Pure reduction over execution rows, kept separate from the fetch so the
 * counting rules are testable without an orderbook.
 *
 * Only `fulfilled` orders count: an open or expired order is an intention,
 * not a track record. Surplus averages over the fills that priced, so a fill
 * whose surplus is not computable still counts as a fill without dragging the
 * average toward zero.
 */
export function aggregateTrackRecord(
  rows: readonly Pick<ExecOrderRow, 'status' | 'surplusBps' | 'creationDate'>[],
): TrackRecord {
  let fills = 0;
  let bpsSum = 0;
  let bpsCount = 0;
  let best: number | null = null;
  let firstSeen: string | null = null;
  let firstSeenAt = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (row.status !== 'fulfilled') continue;
    fills += 1;

    if (row.surplusBps !== null && Number.isFinite(row.surplusBps)) {
      bpsSum += row.surplusBps;
      bpsCount += 1;
      if (best === null || row.surplusBps > best) best = row.surplusBps;
    }
    // Upstream dates are ISO strings, but this list comes off a public API:
    // one unparseable date must not become the record's start.
    const at = Date.parse(row.creationDate);
    if (Number.isFinite(at) && at < firstSeenAt) {
      firstSeenAt = at;
      firstSeen = row.creationDate;
    }
  }

  return {
    fills,
    avgSurplusBps: bpsCount > 0 ? bpsSum / bpsCount : null,
    bestFillBps: best,
    firstSeen,
  };
}

/**
 * Cumulative track record for one wallet, over the same cached Ophis-attributed
 * order fetch the execution panel reads.
 *
 * The address is lower-cased before it goes in, because the cache key is the
 * argument: the registry stores a checksummed wallet and the index serves the
 * same address lower-cased, so without this a page rendering both panels would
 * fetch the same orders twice under two keys.
 */
export async function getTrackRecord(owner: string): Promise<TrackRecord> {
  'use cache';
  cacheLife('minutes');
  const exec = await getExecutionSummary(owner.toLowerCase());
  return aggregateTrackRecord(exec.rows);
}

export interface ReceiptPayload {
  receipt: MevProofReceipt;
  order: CowOrder;
  trade: CowTrade | null;
}

/** Full receipt for one order uid (fetched on demand when a user opens it). */
export async function getReceipt(uid: string): Promise<ReceiptPayload | null> {
  'use cache';
  cacheLife('hours');
  let order: CowOrder;
  try {
    order = await cow.getOrder(uid);
  } catch {
    return null;
  }
  // Only mint an Ophis-branded receipt for an actually-Ophis order, and only
  // when the full appData JSON hashes to the signed appData field. This binds
  // the receipt to what the order owner signed, so a hostile order feed
  // cannot attach appCode:"ophis" to an unrelated order.
  if (!isOphisOrder(order)) return null;
  if (order.fullAppData) {
    const boundHash = keccak256(toBytes(order.fullAppData));
    if (order.appData && boundHash.toLowerCase() !== order.appData.toLowerCase()) {
      return null;
    }
  }
  const trades = await cow.getTrades({ orderUid: uid }).catch(() => []);
  // A trade for a different order must not be stapled onto this receipt.
  const trade = trades.find((t) => t.orderUid === uid) ?? null;
  return { receipt: buildReceipt({ order, trade, chainId: 56 }), order, trade };
}
