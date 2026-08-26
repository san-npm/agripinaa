import { ERC8004_REGISTRIES } from '@agripinaa/shared';

import { CATEGORIES, type AgentSummary, type Category, type TrustData } from './types';

/**
 * The committed offline snapshot: what the site lists when the indexer is
 * unavailable or rate limited.
 *
 * The envelope is what it has always been (`chainId`, `seededAt`, `items`).
 * The rows are compact, because the file is a few thousand registrations and
 * the full `AgentSummary` spends most of its bytes on values a reader already
 * knows: the chain, the id (chain + token), the agent id (chain + registry +
 * token), the `Agent #<token>` placeholder the indexer uses when it has not
 * fetched the agentURI document, the fetch timestamp (the seed run's), and a
 * trust record that is zeroed for almost every registration. A row therefore
 * carries only what deviates from those defaults, which is around a fifth of
 * the bytes and keeps the file well inside a git-friendly size.
 *
 * Request-time fields (`claimed`, `endpoint`, `endpointLive`, `duplicateCount`)
 * are deliberately not part of it: they come from KV and from ranking, and a
 * three-week-old copy of them would be wrong rather than stale.
 */
export interface CompactAgent {
  /** tokenId. The only required field besides the owner. */
  t: string;
  /** owner address. */
  o: string;
  /** name; absent means the indexer's `Agent #<tokenId>` placeholder. */
  n?: string;
  /** description; absent means ''. */
  d?: string;
  /** imageUrl; absent means null. */
  i?: string;
  /** category; absent means null (not in any hub). */
  c?: Category;
  /** supportedProtocols; absent means []. */
  p?: string[];
  /** x402Supported; present only when true. */
  x?: 1;
  /** registeredAt; absent means null. */
  r?: string;
  /** agentId; absent means the one derived from the chain's identity registry. */
  g?: string;
  /** trust.isVerified; present only when true. */
  v?: 1;
  /** trust.totalScore; absent means 0. */
  s?: number | null;
  /** trust.averageScore; absent means 0. */
  a?: number | null;
  /** trust.rank; absent means null. */
  k?: number | null;
  /** trust.healthScore; absent means null. */
  h?: number | null;
  /** trust.totalFeedbacks; absent means 0. */
  f?: number;
  /** trust.starCount; absent means 0. */
  w?: number | null;
  /** trust.breakdown; absent means none was reported. */
  b?: Record<string, number>;
}

export interface Snapshot {
  chainId: number;
  seededAt: string;
  items: AgentSummary[];
}

/**
 * The agent id every ERC-8004 record on a known chain has: chain, identity
 * registry, token. Matches what the indexer reports and what a direct registry
 * read builds, so a row only stores its own id when it disagrees with this.
 */
function derivedAgentId(chainId: number, tokenId: string): string | null {
  const identity = ERC8004_REGISTRIES[chainId]?.identity;
  return identity ? `${chainId}:${identity.toLowerCase()}:${tokenId}` : null;
}

function placeholderName(tokenId: string): string {
  return `Agent #${tokenId}`;
}

export function toCompact(agent: AgentSummary): CompactAgent {
  const row: CompactAgent = { t: agent.tokenId, o: agent.owner };
  if (agent.name !== placeholderName(agent.tokenId)) row.n = agent.name;
  if (agent.description !== '') row.d = agent.description;
  if (agent.imageUrl != null) row.i = agent.imageUrl;
  if (agent.category != null) row.c = agent.category;
  if (agent.supportedProtocols.length > 0) row.p = agent.supportedProtocols;
  if (agent.x402Supported) row.x = 1;
  if (agent.registeredAt != null) row.r = agent.registeredAt;
  if (agent.agentId !== derivedAgentId(agent.chainId, agent.tokenId)) row.g = agent.agentId;

  const trust = agent.trust;
  if (trust.isVerified) row.v = 1;
  if (trust.totalScore !== 0) row.s = trust.totalScore;
  if (trust.averageScore !== 0) row.a = trust.averageScore;
  if (trust.rank != null) row.k = trust.rank;
  if (trust.healthScore != null) row.h = trust.healthScore;
  if (trust.totalFeedbacks !== 0) row.f = trust.totalFeedbacks;
  if (trust.starCount !== 0) row.w = trust.starCount;
  if (trust.breakdown) row.b = trust.breakdown;
  return row;
}

export function fromCompact(
  row: CompactAgent,
  ctx: { chainId: number; asOf: string },
): AgentSummary {
  const tokenId = row.t;
  const trust: TrustData = {
    totalScore: row.s === undefined ? 0 : row.s,
    averageScore: row.a === undefined ? 0 : row.a,
    rank: row.k ?? null,
    healthScore: row.h ?? null,
    totalFeedbacks: row.f ?? 0,
    starCount: row.w === undefined ? 0 : row.w,
    isVerified: row.v === 1,
    source: '8004scan',
    asOf: ctx.asOf,
  };
  if (row.b) trust.breakdown = row.b;
  return {
    id: `${ctx.chainId}-${tokenId}`,
    chainId: ctx.chainId,
    tokenId,
    agentId: row.g ?? derivedAgentId(ctx.chainId, tokenId) ?? `${ctx.chainId}:${tokenId}`,
    name: row.n ?? placeholderName(tokenId),
    description: row.d ?? '',
    imageUrl: row.i ?? null,
    owner: row.o,
    category: row.c ?? null,
    supportedProtocols: row.p ?? [],
    x402Supported: row.x === 1,
    registeredAt: row.r ?? null,
    trust,
  };
}

/**
 * What a seed run writes: the rows it just fetched, then whatever the committed
 * file already had, deduped by token id and capped.
 *
 * A seed run replaces the file it reads, so this is the rule that keeps a run
 * from costing more than it adds. A run that stops on page five (an expired
 * key, a 422, a dropped connection) has five pages of fresh rows and no reason
 * to throw away the thousands already on disk, and a run that fetched nothing
 * leaves the file exactly as it was. Fresh rows come first because the listing
 * is ordered by registration, and a row fetched now wins over the older copy of
 * itself.
 *
 * One thing a carried row does not keep: every row reads its `trust.asOf` from
 * the envelope, so a row carried through a stopped run is stamped with that
 * run's clock while its scores are the ones the earlier run fetched. The gap is
 * one seed interval, and it costs a per-row timestamp to close, so it is left
 * open and written down here.
 */
export function mergeSnapshotItems(input: {
  fetched: AgentSummary[];
  onDisk: AgentSummary[];
  /** Rows to end up with. Never applied to the fetched rows, only to the carried ones. */
  keep: number;
}): AgentSummary[] {
  const out: AgentSummary[] = [];
  const seen = new Set<string>();
  for (const item of input.fetched) {
    if (seen.has(item.tokenId)) continue;
    seen.add(item.tokenId);
    out.push(item);
  }
  for (const item of input.onDisk) {
    if (out.length >= input.keep) break;
    if (seen.has(item.tokenId)) continue;
    seen.add(item.tokenId);
    out.push(item);
  }
  return out;
}

/** The file the seeder writes. One line per row keeps a diff readable. */
export function encodeSnapshot(snapshot: {
  chainId: number;
  seededAt: string;
  items: AgentSummary[];
}): string {
  const rows = snapshot.items.map((a) => JSON.stringify(toCompact(a)));
  return `{\n"chainId": ${snapshot.chainId},\n"seededAt": ${JSON.stringify(snapshot.seededAt)},\n"items": [\n${rows.join(',\n')}\n]\n}\n`;
}

function isCategory(value: unknown): value is Category {
  return CATEGORIES.some((c) => c === value);
}

/**
 * A row written before the compact shape existed: a whole `AgentSummary`. Read
 * as well as the compact rows so that restoring an older copy of the data file,
 * on its own, still leaves a usable fallback tier instead of an empty one.
 */
function isFullRecord(row: Record<string, unknown>): boolean {
  return typeof row['id'] === 'string' && typeof row['tokenId'] === 'string';
}

/**
 * Read the committed snapshot. Answers null when the file is not one, so a
 * caller falls through to its next tier instead of listing nothing; rows
 * without a token id are dropped, since there is no agent to address.
 */
export function parseSnapshot(raw: string): Snapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  const chainId = envelope['chainId'];
  const seededAt = envelope['seededAt'];
  const items = envelope['items'];
  if (typeof chainId !== 'number' || typeof seededAt !== 'string') return null;
  if (!Array.isArray(items)) return null;

  const out: AgentSummary[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (isFullRecord(row)) {
      out.push(row as unknown as AgentSummary);
      continue;
    }
    if (typeof row['t'] !== 'string' || row['t'] === '') continue;
    if (typeof row['o'] !== 'string') continue;
    const compact = row as unknown as CompactAgent;
    out.push(
      fromCompact(
        { ...compact, c: isCategory(compact.c) ? compact.c : undefined },
        { chainId, asOf: seededAt },
      ),
    );
  }
  return { chainId, seededAt, items: out };
}
