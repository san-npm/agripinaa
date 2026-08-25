import 'server-only';

import {
  PROOF_AGENT_LIST,
  TOKENS_BSC,
  type ProofEvent,
  type ProofFeedPayload,
  type ProofKind,
} from '@agripinaa/shared';
import {
  CowOrderbookClient,
  isOphisOrder,
  surplusBps,
} from '@agripinaa/exec-metrics';
import { safeFetchJson } from '@agripinaa/shared/ssrf';
import { cacheLife } from 'next/cache';

import { runnerUrl } from './runner-url';

const timedCowFetch: typeof fetch = (input, init) => fetch(input, {
  ...init,
  signal: AbortSignal.timeout(3_000),
});
const cow = new CowOrderbookClient({ fetch: timedCowFetch });
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ORDER_UID = /^0x[0-9a-fA-F]{112}$/;
const KINDS = new Set<ProofKind>(['trade', 'repair', 'rotate', 'rebalance', 'mint']);
const AGENT_BY_ID = new Map(PROOF_AGENT_LIST.map((agent) => [agent.tokenId, agent]));
const SYMBOL_BY_ADDRESS = new Map(
  Object.values(TOKENS_BSC).map((token) => [token.address.toLowerCase(), token.symbol]),
);
/** Forty events with hashes and summaries are a few tens of KB; this is ample. */
const PROOF_MAX_BYTES = 256 * 1024;

async function proofEndpoint(): Promise<string> {
  return runnerUrl('/proof');
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Treat the tunnel as an untrusted boundary: allow only the four verified
 * identities and overwrite display metadata from the committed registry.
 */
export function normalizeProofEvents(value: unknown): ProofEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ProofEvent[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    const agentId = typeof row.agent === 'string' ? row.agent : '';
    const meta = AGENT_BY_ID.get(agentId);
    const kind = typeof row.kind === 'string' && KINDS.has(row.kind as ProofKind)
      ? row.kind as ProofKind
      : null;
    const summary = typeof row.summary === 'string' ? row.summary.trim().slice(0, 180) : '';
    const at = typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : null;
    if (!meta || !kind || !summary || !at) return [];

    const txHash = typeof row.txHash === 'string' && TX_HASH.test(row.txHash)
      ? row.txHash as `0x${string}`
      : undefined;
    const orderUid = typeof row.orderUid === 'string' && ORDER_UID.test(row.orderUid)
      ? row.orderUid as `0x${string}`
      : undefined;
    if (!txHash && !orderUid) return [];
    const surplus = optionalNumber(row.surplusBps);
    const hf = optionalNumber(row.hf);
    const id = typeof row.id === 'string' && row.id.length > 0
      ? row.id.slice(0, 240)
      : `${agentId}:${kind}:${txHash ?? orderUid ?? at}`;

    return [{
      id,
      agent: meta.tokenId,
      agentName: meta.name,
      category: meta.category,
      kind,
      summary,
      at,
      ...(txHash ? { txHash } : {}),
      ...(orderUid ? { orderUid } : {}),
      ...(surplus !== undefined && Math.abs(surplus) <= 100_000 ? { surplusBps: surplus } : {}),
      ...(hf !== undefined && hf > 0 && hf < 1_000 ? { hf } : {}),
    }];
  });
}

function tokenSymbol(address: string): string {
  return SYMBOL_BY_ADDRESS.get(address.toLowerCase()) ?? `${address.slice(0, 6)}…`;
}

async function getOnchainTradeBackfill(): Promise<ProofEvent[]> {
  'use cache';
  cacheLife('minutes');

  const agents = PROOF_AGENT_LIST.filter((agent) => agent.backfillOphisTrades);
  const batches = await Promise.all(agents.map(async (agent) => {
    try {
      const [orders, trades] = await Promise.all([
        cow.getAccountOrders(agent.wallet, { limit: 100 }),
        cow.getTrades({ owner: agent.wallet }),
      ]);
      const tradeByOrder = new Map(trades.map((trade) => [trade.orderUid, trade]));
      return orders
        .filter((order) => order.status === 'fulfilled' && ORDER_UID.test(order.uid) && isOphisOrder(order))
        .map((order): ProofEvent => {
          const trade = tradeByOrder.get(order.uid);
          const txHash = trade && TX_HASH.test(trade.txHash)
            ? trade.txHash as `0x${string}`
            : undefined;
          const bps = surplusBps(order);
          return {
            id: `${agent.tokenId}:trade:${order.uid}`,
            agent: agent.tokenId,
            agentName: agent.name,
            category: agent.category,
            kind: 'trade',
            summary: `Filled ${tokenSymbol(order.sellToken)} → ${tokenSymbol(order.buyToken)} through Ophis`,
            at: order.creationDate,
            orderUid: order.uid as `0x${string}`,
            ...(txHash ? { txHash } : {}),
            ...(bps !== null ? { surplusBps: bps } : {}),
          };
        });
    } catch {
      return [];
    }
  }));

  return batches.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);
}

/**
 * The runner's own event feed, read through the SSRF guard: the tunnel base
 * is attacker-influenceable, so every redirect hop is re-validated against
 * the private ranges and the body is capped while it streams. Any failure is
 * an empty list; the on-chain backfill still fills the feed.
 */
export async function getRunnerEvents(): Promise<ProofEvent[]> {
  const payload = await safeFetchJson(await proofEndpoint(), {
    timeoutMs: 5_000,
    maxBytes: PROOF_MAX_BYTES,
  });
  return payload ? normalizeProofEvents((payload as { events?: unknown }).events) : [];
}

function mergeEvents(runner: ProofEvent[], chain: ProofEvent[]): ProofEvent[] {
  const merged = new Map<string, ProofEvent>();
  const key = (event: ProofEvent) => event.orderUid ?? event.txHash ?? event.id;
  for (const event of chain) merged.set(key(event), event);
  for (const event of runner) {
    const previous = merged.get(key(event));
    merged.set(key(event), previous
      ? {
          ...previous,
          ...event,
          txHash: event.txHash ?? previous.txHash,
          surplusBps: event.surplusBps ?? previous.surplusBps,
        }
      : event);
  }
  return [...merged.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 40);
}

/** Fifteen-second cached BFF payload with a slower on-chain cold-start backfill. */
export async function getProofFeed(): Promise<ProofFeedPayload> {
  'use cache';
  cacheLife({ stale: 15, revalidate: 15, expire: 60 });

  const [runner, chain] = await Promise.all([getRunnerEvents(), getOnchainTradeBackfill()]);
  const events = mergeEvents(runner, chain);
  return {
    events,
    asOf: new Date().toISOString(),
    source: runner.length > 0
      ? chain.length > 0 ? 'runner+chain' : 'runner'
      : chain.length > 0 ? 'chain' : 'none',
  };
}
