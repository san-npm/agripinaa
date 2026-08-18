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
