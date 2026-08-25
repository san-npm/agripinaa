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
  agentBySlug,
  type ProofAgent,
  type ProofAgentSlug,
  type ProofEvent,
} from '@agripinaa/shared';
import { CowOrderbookClient, surplusBps } from '@agripinaa/exec-metrics';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const MAX_TAIL_BYTES = 256 * 1024;
const MAX_LINES_PER_AGENT = 2_000;
const VERIFICATION_BATCH_SIZE = 12;
const VERIFICATION_BUDGET_MS = 2_500;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_VALUE = /^0x[0-9a-fA-F]+$/;

type LogEntry = Record<string, unknown>;
type ProofCandidate = ProofEvent & { fulfilledSummary?: string };

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

/**
 * The health factor the SAME agent read just after a repair, which is what
 * makes the repair legible ("restoring HF to 1.71"). Scoped to the entry's own
 * slug: two guardians run on two protocols (Aave and Venus) and both log `hf`,
 * so a hardcoded slug would decorate one agent's repair with the other's
 * position.
 */
function firstHealthFactorAfter(
  entries: readonly LogEntry[],
  at: string,
  slug: ProofAgentSlug,
): number | undefined {
  const atMs = Date.parse(at);
  const match = entries
    .filter((entry) => entry.agent === slug && entry.event === 'hf')
    .map((entry) => ({ at: validAt(entry.at), hf: numberValue(entry.hf) }))
    .filter((entry): entry is { at: string; hf: number } => entry.at !== undefined && entry.hf !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .find((entry) => Date.parse(entry.at) >= atMs && Date.parse(entry.at) - atMs <= 5 * 60_000);
  return match?.hf;
}

/**
 * The two symbols a grid trades, base first, read from its own registry record
 * rather than from the slug. Two grids run this same event now (WBNB/USDT and
 * BTCB/USDT) and a third would be one record away, so naming the legs per slug
 * in code is how a new grid's fills end up labelled as an older one's market.
 * A record with no published pair falls back to what the line itself carries.
 */
function gridLegs(
  slug: ProofAgentSlug,
  side: 'buy' | 'sell',
  clipToken: string | undefined,
): { from: string; to: string } {
  const [base, quote] = (agentBySlug(slug)?.manifest.execution.pair ?? '').split('/');
  if (!base || !quote) return { from: clipToken ?? 'inventory', to: 'the paired asset' };
  return side === 'sell' ? { from: base, to: quote } : { from: quote, to: base };
}

const VENUE_NAMES: Record<string, string> = { aave: 'Aave', venus: 'Venus' };

/**
 * One log line into one public feed row, or null.
 *
 * Dispatch is on the agent's CATEGORY plus the event name, never on the slug:
 * agents in a category share their strategy module and therefore their log
 * shapes (grid with grid-b, health-factor with venus-guardian, yield with
 * yield-b), and a slug literal here is the reason a newly registered agent
 * ticks, trades, and shows an empty track record on the marketplace.
 */
function mapLogEntry(
  entry: LogEntry,
  entries: readonly LogEntry[],
  agents: Partial<Record<ProofAgentSlug, ProofAgent>>,
): ProofCandidate | null {
  const slug = stringValue(entry.agent) as ProofAgentSlug | undefined;
  const meta = slug ? agents[slug] : undefined;
  const event = stringValue(entry.event);
  const at = validAt(entry.at);
  if (!meta || !slug || !event || !at) return null;

  const base = {
    agent: meta.tokenId,
    agentName: meta.name,
    category: meta.category,
    at,
  } as const;

  if (meta.category === 'grid' && event === 'trade-submitted') {
    const orderUid = orderValue(entry.orderUid);
    if (!orderUid) return null;
    const side = entry.side === 'buy' ? 'buy' : 'sell';
    const { from, to } = gridLegs(slug, side, stringValue(entry.clipToken));
    const amount = stringValue(entry.clipAmount);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, orderUid),
      kind: 'trade',
      summary: `Submitted${amount ? ` ${amount}` : ''} ${from} → ${to} to Ophis`,
      fulfilledSummary: `Filled${amount ? ` ${amount}` : ''} ${from} → ${to} through Ophis`,
      orderUid,
    };
  }

  if (meta.category === 'health-factor' && event === 'repair-done') {
    const txHash = txValue(entry.txHash);
    if (!txHash) return null;
    const repaid = stringValue(entry.repaidUsdt);
    const hf = firstHealthFactorAfter(entries, at, slug);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'repair',
      summary: `Repaid${repaid ? ` ${Number(repaid).toLocaleString('en-US', { maximumFractionDigits: 4 })}` : ''} USDT${hf ? `, restoring HF to ${hf.toFixed(2)}` : ''}`,
      txHash,
      ...(hf !== undefined ? { hf } : {}),
    };
  }

  if (meta.category === 'yield' && event === 'supply') {
    const txHash = txValue(entry.txHash);
    if (!txHash) return null;
    const amount = stringValue(entry.amount);
    const venue = stringValue(entry.venue);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'rotate',
      summary: `Allocated${amount ? ` ${amount}` : ''} USDT to ${venue ? (VENUE_NAMES[venue] ?? venue) : 'the leading venue'}`,
      txHash,
    };
  }

  if (meta.category === 'yield' && event === 'withdraw') {
    const txHash = txValue(entry.txHash);
    if (!txHash) return null;
    const venue = stringValue(entry.venue);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, txHash),
      kind: 'rotate',
      summary: `Withdrew USDT from ${venue ? (VENUE_NAMES[venue] ?? venue) : 'the previous venue'} for a rate rotation`,
      txHash,
    };
  }

  if (meta.category === 'rebalancing' && event === 'minted') {
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

  if (meta.category === 'rebalancing' && (event === 'decrease-liquidity' || event === 'collected')) {
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

  // Both rebalancing agents place their swap through Ophis and log the same
  // fields for it (symbols, not addresses): lp-range to re-balance the
  // inventory around a position, weight-rebalancer to hold a target weight.
  if (
    meta.category === 'rebalancing' &&
    (event === 'ophis-swap-submitted' || event === 'rebalance-submitted')
  ) {
    const orderUid = orderValue(entry.orderUid);
    if (!orderUid) return null;
    const from = stringValue(entry.sellToken) ?? 'token inventory';
    const to = stringValue(entry.buyToken) ?? 'the paired asset';
    const amount = stringValue(entry.sellAmount);
    return {
      ...base,
      id: eventId(meta.tokenId, event, at, orderUid),
      kind: 'trade',
      summary: `Submitted${amount ? ` ${amount}` : ''} ${from} → ${to} rebalance to Ophis`,
      fulfilledSummary: `Rebalanced${amount ? ` ${amount}` : ''} ${from} → ${to} through Ophis`,
      orderUid,
    };
  }

  return null;
}

/**
 * Map the deliberately small allowlist of public, meaningful log events.
 *
 * `agents` is the roster a line's `agent` field is resolved against, and
 * defaults to the registered agents. It is a parameter because PROOF_AGENTS
 * admits a record only once it carries a token id and a wallet, so the mapping
 * for an agent that is built but not yet minted is otherwise unprovable.
 */
export function mapProofLogEntries(
  entries: readonly LogEntry[],
  agents: Partial<Record<ProofAgentSlug, ProofAgent>> = PROOF_AGENTS,
): ProofEvent[] {
  const mapped = entries
    .map((entry) => mapLogEntry(entry, entries, agents))
    // The public feed promises a receipt for every row. Fail closed for
    // telemetry and for any future mapped event without an on-chain anchor.
    .filter((entry): entry is ProofCandidate =>
      entry !== null && (entry.txHash !== undefined || entry.orderUid !== undefined))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const seen = new Set<string>();
  return mapped.filter((entry) => {
    const key = entry.orderUid ?? entry.txHash ?? entry.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

type OphisTradeLookup = Pick<CowOrderbookClient, 'getOrder' | 'getTrades'>;

export async function enrichOphisTrades(
  events: ProofCandidate[],
  options: {
    budgetMs?: number;
    limit?: number;
    lookup?: OphisTradeLookup;
    now?: () => number;
  } = {},
): Promise<ProofEvent[]> {
  const now = options.now ?? Date.now;
  const budgetMs = Math.max(0, Math.floor(options.budgetMs ?? VERIFICATION_BUDGET_MS));
  const deadline = now() + budgetMs;
  const timedFetch: typeof fetch = (input, init) => fetch(input, {
    ...init,
    // Every request shares one absolute deadline, so sequential batches can
    // never multiply the timeout into minutes of blocked /proof latency.
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
  });
  const client = options.lookup ?? new CowOrderbookClient({ fetch: timedFetch });
  const limit = Math.max(0, Math.floor(options.limit ?? events.length));

  const verify = async (event: ProofCandidate): Promise<ProofEvent | null> => {
    const { fulfilledSummary, ...publicEvent } = event;
    if (!event.orderUid) return publicEvent;
    if (now() >= deadline) return null;
    try {
      const order = await client.getOrder(event.orderUid);
      if (order.status !== 'fulfilled') return null;
      const trades = now() < deadline
        ? await client.getTrades({ orderUid: event.orderUid }).catch(() => [])
        : [];
      const trade = trades.find((candidate) => candidate.orderUid === event.orderUid);
      const txHash = txValue(trade?.txHash);
      const bps = surplusBps(order);
      return {
        ...publicEvent,
        summary: fulfilledSummary ?? publicEvent.summary,
        ...(txHash ? { txHash } : {}),
        ...(bps !== null ? { surplusBps: bps } : {}),
      };
    } catch {
      // Without a fulfilled orderbook lookup, a submission is not proof of an
      // execution. Omit it until a later cached read can verify settlement.
      return null;
    }
  };

  const verified: ProofEvent[] = [];
  // Twelve is a concurrency window, not a total lookup cap. Keep walking the
  // sorted candidates until the requested number of verified rows is found.
  // Once the shared network deadline expires, order candidates fail closed
  // immediately while older receipt-bearing, non-order events still flow.
  for (let offset = 0; offset < events.length && verified.length < limit; offset += VERIFICATION_BATCH_SIZE) {
    const batch = await Promise.all(
      events.slice(offset, offset + VERIFICATION_BATCH_SIZE).map(verify),
    );
    verified.push(...batch.filter((event): event is ProofEvent => event !== null));
  }
  return verified.slice(0, limit);
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
  return enrichOphisTrades(mapProofLogEntries(entries), { limit });
}
