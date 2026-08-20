import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROOF_AGENTS,
  type ProofAgentSlug,
  type ProofEvent,
} from '@agripinaa/shared';
import { CowOrderbookClient, surplusBps } from '@agripinaa/exec-metrics';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const MAX_TAIL_BYTES = 256 * 1024;
const MAX_LINES_PER_AGENT = 2_000;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_VALUE = /^0x[0-9a-fA-F]+$/;

type LogEntry = Record<string, unknown>;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function txValue(value: unknown): `0x${string}` | undefined {
  const text = stringValue(value);
  return text && TX_HASH.test(text) ? (text as `0x${string}`) : undefined;
}

function orderValue(value: unknown): `0x${string}` | undefined {
  const text = stringValue(value);
  return text && HEX_VALUE.test(text) ? (text as `0x${string}`) : undefined;
}

function validAt(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function eventId(
  agentId: string,
  event: string,
  at: string,
  ref?: string,
): string {
  return `${agentId}:${event}:${ref ?? at}`;
}

function firstHealthFactorAfter(entries: readonly LogEntry[], at: string): number | undefined {
  const atMs = Date.parse(at);
  const match = entries
    .filter((entry) => entry.agent === 'health-factor' && entry.event === 'hf')
    .map((entry) => ({ at: validAt(entry.at), hf: numberValue(entry.hf) }))
    .filter((entry): entry is { at: string; hf: number } => entry.at !== undefined && entry.hf !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .find((entry) => Date.parse(entry.at) >= atMs && Date.parse(entry.at) - atMs <= 5 * 60_000);
  return match?.hf;
}

function mapLogEntry(entry: LogEntry, entries: readonly LogEntry[]): ProofEvent | null {
  const slug = stringValue(entry.agent) as ProofAgentSlug | undefined;
  const meta = slug ? PROOF_AGENTS[slug] : undefined;
  const event = stringValue(entry.event);
  const at = validAt(entry.at);
  if (!meta || !event || !at) return null;

  const base = {
    agent: meta.tokenId,
    agentName: meta.name,
    category: meta.category,
    at,
  } as const;

  if (slug === 'grid' && event === 'trade-submitted') {
    const orderUid = orderValue(entry.orderUid);
    if (!orderUid) return null;
    const side = entry.side === 'buy' ? 'buy' : 'sell';
    const from = side === 'sell' ? 'WBNB' : 'USDT';
    const to = side === 'sell' ? 'USDT' : 'WBNB';
    const amount = stringValue(entry.clipAmount);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, orderUid),
      kind: 'trade',
      summary: `Filled${amount ? ` ${amount}` : ''} ${from} → ${to} through Ophis`,
      orderUid,
    };
  }

  if (slug === 'health-factor' && event === 'repair-done') {
    const txHash = txValue(entry.txHash);
    if (!txHash) return null;
    const repaid = stringValue(entry.repaidUsdt);
    const hf = firstHealthFactorAfter(entries, at);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'repair',
      summary: `Repaid${repaid ? ` ${Number(repaid).toLocaleString('en-US', { maximumFractionDigits: 4 })}` : ''} USDT${hf ? `, restoring HF to ${hf.toFixed(2)}` : ''}`,
      txHash,
      ...(hf !== undefined ? { hf } : {}),
    };
  }

  if (slug === 'yield' && event === 'supply') {
    const txHash = txValue(entry.txHash);
    if (!txHash) return null;
    const amount = stringValue(entry.amount);
    const venue = stringValue(entry.venue) ?? 'the leading venue';
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'rotate',
      summary: `Allocated${amount ? ` ${amount}` : ''} USDT to ${venue === 'aave' ? 'Aave' : venue === 'venus' ? 'Venus' : venue}`,
      txHash,
    };
  }

  if (slug === 'yield' && event === 'withdraw') {
    const txHash = txValue(entry.txHash);
    if (!txHash) return null;
    const venue = stringValue(entry.venue) ?? 'the previous venue';
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'rotate',
      summary: `Withdrew USDT from ${venue === 'aave' ? 'Aave' : venue === 'venus' ? 'Venus' : venue} for a rate rotation`,
      txHash,
    };
  }

  if (slug === 'lp-range' && event === 'minted') {
    const txHash = txValue(entry.txHash);
    const tokenId = stringValue(entry.tokenId);
    if (!txHash || !tokenId) return null;
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'mint',
      summary: `Minted WBNB/USDT liquidity position #${tokenId}`,
      txHash,
    };
  }

  if (slug === 'lp-range' && event === 'range-check') {
    const tokenId = stringValue(entry.tokenId);
    if (!tokenId || typeof entry.inRange !== 'boolean') return null;
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, `${tokenId}:${entry.inRange}`),
      kind: 'rebalance',
      summary: entry.inRange
        ? `Confirmed liquidity position #${tokenId} remains in range`
        : `Detected liquidity position #${tokenId} outside its range`,
    };
  }

  if (slug === 'lp-range' && event === 'rebalance-start') {
    const tokenId = stringValue(entry.tokenId);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, tokenId),
      kind: 'rebalance',
      summary: `Started${tokenId ? ` position #${tokenId}` : ''} rebalance after the range moved`,
    };
  }

  if (slug === 'lp-range' && (event === 'decrease-liquidity' || event === 'collected')) {
    const txHash = txValue(entry.txHash);
    const tokenId = stringValue(entry.tokenId);
    if (!txHash) return null;
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'rebalance',
      summary: event === 'collected'
        ? `Collected position #${tokenId ?? '—'} before rebalancing`
        : `Removed liquidity from position #${tokenId ?? '—'} for rebalancing`,
      txHash,
    };
  }

  if (slug === 'lp-range' && event === 'ophis-swap-submitted') {
    const orderUid = orderValue(entry.orderUid);
    if (!orderUid) return null;
    const from = stringValue(entry.sellToken) ?? 'token inventory';
    const to = stringValue(entry.buyToken) ?? 'the paired asset';
    const amount = stringValue(entry.sellAmount);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, orderUid),
      kind: 'trade',
      summary: `Rebalanced${amount ? ` ${amount}` : ''} ${from} → ${to} through Ophis`,
      orderUid,
    };
  }

  return null;
}

/** Map the deliberately small allowlist of public, meaningful log events. */
export function mapProofLogEntries(
  entries: readonly LogEntry[],
  limit = 40,
): ProofEvent[] {
  const mapped = entries
    .map((entry) => mapLogEntry(entry, entries))
    .filter((entry): entry is ProofEvent => entry !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const seen = new Set<string>();
  return mapped.filter((entry) => {
    // Range checks are telemetry every ten minutes. Keep only the newest
    // state so they cannot bury scarce, receipt-bearing actions.
    const key = entry.id.includes(':range-check:')
      ? `${entry.agent}:range-check:${entry.summary.includes('remains in range')}`
      : entry.orderUid ?? entry.txHash ?? entry.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(0, limit));
}

function readTail(file: string): LogEntry[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_LINES_PER_AGENT)
      .flatMap((line): LogEntry[] => {
        try {
          const value: unknown = JSON.parse(line);
          return value && typeof value === 'object' ? [value as LogEntry] : [];
        } catch {
          return [];
        }
      });
  } finally {
    closeSync(fd);
  }
}

async function enrichOphisTrades(events: ProofEvent[]): Promise<ProofEvent[]> {
  const timedFetch: typeof fetch = (input, init) => fetch(input, {
    ...init,
    signal: AbortSignal.timeout(3_000),
  });
  const client = new CowOrderbookClient({ fetch: timedFetch });
  const orderUids = [...new Set(events.flatMap((event) => event.orderUid ? [event.orderUid] : []))].slice(0, 12);
  const enriched = new Map<string, { txHash?: `0x${string}`; surplusBps?: number }>();

  await Promise.all(orderUids.map(async (orderUid) => {
    try {
      const [order, trades] = await Promise.all([
        client.getOrder(orderUid),
        client.getTrades({ orderUid }),
      ]);
      const trade = trades.find((candidate) => candidate.orderUid === orderUid);
      const txHash = txValue(trade?.txHash);
      const bps = order.status === 'fulfilled' ? surplusBps(order) : null;
      enriched.set(orderUid, {
        ...(txHash ? { txHash } : {}),
        ...(bps !== null ? { surplusBps: bps } : {}),
      });
    } catch {
      // Submission is still a valid public event while settlement is pending
      // or the orderbook is unavailable. The next cached read enriches it.
    }
  }));

  return events.map((event) => event.orderUid
    ? { ...event, ...(enriched.get(event.orderUid) ?? {}) }
    : event);
}

export async function collectProofEvents(
  agents: readonly string[],
  limit = 40,
): Promise<ProofEvent[]> {
  const entries = agents.flatMap((name) => {
    if (!(name in PROOF_AGENTS)) return [];
    return readTail(join(DATA_DIR, `${name}.log.jsonl`)).map((entry) => ({
      ...entry,
      agent: name,
    }));
  });
  return enrichOphisTrades(mapProofLogEntries(entries, limit));
}
