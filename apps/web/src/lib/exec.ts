import 'server-only';

import { isAddress } from 'viem';
import {
  buildReceipt,
  CowOrderbookClient,
  isAuthenticOphisOrder,
  summarizeSurplus,
  surplusBps,
  type CowOrder,
  type CowTrade,
  type MevProofReceipt,
  type SurplusSummary,
} from '@agripinaa/exec-metrics';
import { cacheLife } from 'next/cache';

const cow = new CowOrderbookClient();

/**
 * How many of a wallet's most recent orders one fetch covers. Every figure
 * derived from that fetch describes this window and nothing older, so the
 * panels that print those figures import the number rather than restate it.
 */
export const EXEC_ORDER_WINDOW = 100;

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
  const orders = await cow.getAccountOrders(owner as `0x${string}`, {
    limit: EXEC_ORDER_WINDOW,
  });
  const ophisOrders = orders.filter((o) => isAuthenticOphisOrder(o));
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
 * One agent's settlement record over the fetched window, reduced to the four
 * numbers a reader compares across agents. Deliberately plain data: the
 * leaderboard ranks these side by side, so nothing page-specific belongs here.
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
  /** ISO timestamp of the earliest fill in the window. */
  firstSeen: string | null;
}

/**
 * The two extremes of an agent's fill set: its best-priced fill and the date
 * of its earliest one. Pure, so the rules are testable without an orderbook.
 *
 * Only `fulfilled` orders qualify: an open or expired order is an intention,
 * not a track record. The fill count and the average surplus are deliberately
 * absent, because `summarizeSurplus` in `@agripinaa/exec-metrics` already
 * computes both over the same orders, and a second implementation of the same
 * two numbers would eventually disagree with the first.
 */
export function bestAndFirstFill(
  rows: readonly Pick<ExecOrderRow, 'status' | 'surplusBps' | 'creationDate'>[],
): Pick<TrackRecord, 'bestFillBps' | 'firstSeen'> {
  let bestFillBps: number | null = null;
  let firstSeen: string | null = null;
  let firstSeenAt = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (row.status !== 'fulfilled') continue;

    // Same admission rule as summarizeSurplus: a fill whose surplus did not
    // compute is still a fill, it just has no price to be best.
    const bps = row.surplusBps;
    if (bps !== null && (bestFillBps === null || bps > bestFillBps)) {
      bestFillBps = bps;
    }
    // Upstream dates are ISO strings, but this list comes off a public API:
    // one unparseable date must not become the record's start.
    const at = Date.parse(row.creationDate);
    if (Number.isFinite(at) && at < firstSeenAt) {
      firstSeenAt = at;
      firstSeen = row.creationDate;
    }
  }

  return { bestFillBps, firstSeen };
}

/**
 * Track record for one wallet over the same cached Ophis-attributed order
 * fetch the execution panel reads, so both panels print one set of numbers:
 * the fill count and the average come straight off that fetch's summary.
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
  return {
    fills: exec.summary.filledOrders,
    avgSurplusBps: exec.summary.avgSurplusBps,
    ...bestAndFirstFill(exec.rows),
  };
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
  // Authenticity checking binds the full JSON and every signed field to the
  // same invariant protects receipts, summaries, leaderboards and proof feeds.
  if (!isAuthenticOphisOrder(order)) return null;
  const trades = await cow.getTrades({ orderUid: uid }).catch(() => []);
  // A trade for a different order must not be stapled onto this receipt.
  const trade = trades.find((t) => t.orderUid === uid) ?? null;
  return { receipt: buildReceipt({ order, trade, chainId: 56 }), order, trade };
}
