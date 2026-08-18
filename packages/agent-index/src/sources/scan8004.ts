import { ERC8004_REGISTRIES } from '@agripinaa/shared';
import { classify } from '../classify';
import type { AgentIndexSource } from '../source';
import type {
  AgentDetail,
  AgentSummary,
  Feedback,
  IndexStats,
  ListAgentsQuery,
  Page,
  TrustData,
} from '../types';

const BASE_URL = process.env.SCAN8004_BASE_URL ?? 'https://8004scan.io/api/v1/public';
/**
 * The keyed API surface (no /public suffix) is a DIFFERENT api: offset/limit
 * envelope ({items,total,offset,limit}) and, crucially, a chain_id filter
 * that actually works server-side (verified 2026-08-18: 257,873 BSC agents
 * vs 740k global). 180 req/min + 20k/day with a key.
 */
const KEYED_BASE_URL = process.env.SCAN8004_KEYED_BASE ?? 'https://8004scan.io/api/v1';
const API_KEY = process.env.SCAN8004_API_KEY;
const KEY_HEADER = process.env.SCAN8004_KEY_HEADER ?? 'X-API-Key';

export class Scan8004Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Scan8004Error';
  }
}

interface ScanEnvelope<T> {
  success: boolean;
  data: T;
  meta?: {
    pagination?: { page: number; limit: number; total: number; hasMore: boolean };
  };
}

interface ScanAgent {
  agent_id: string;
  token_id: string;
  chain_id: number;
  contract_address: string;
  owner_address: string;
  agent_wallet?: string | null;
  name: string | null;
  description: string | null;
  image_url: string | null;
  is_verified: boolean;
  star_count: number | null;
  supported_protocols: string[] | null;
  x402_supported: boolean;
  total_score: number | null;
  average_score: number | null;
  rank: number | null;
  health_score: number | null;
  total_feedbacks: number | null;
  created_at: string | null;
  services?: unknown[] | null;
  scores?: Record<string, number> | null;
  agent_uri?: string | null;
  metadata?: Record<string, unknown> | null;
}

async function scanFetch<T>(path: string, params: Record<string, string | number>): Promise<ScanEnvelope<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { accept: 'application/json' };
  if (API_KEY) headers[KEY_HEADER] = API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Scan8004Error(`8004scan ${path} responded ${res.status}`, res.status);
  }
  const json = (await res.json()) as ScanEnvelope<T>;
  if (!json.success) {
    throw new Scan8004Error(`8004scan ${path} returned success=false`);
  }
  return json;
}

/**
 * Verified 2026-08-07: the public /agents list endpoint IGNORES chain
 * filters (`chain_id` and `chain` both return the global, mixed-chain set
 * with a global total). Lists are therefore over-fetched and filtered here,
 * and upstream totals are never surfaced as chain-specific numbers.
 *
 * The detail endpoint (/agents/{chainId}/{tokenId}) IS chain-scoped by
 * path, so a mismatch there is a real bug and throws.
 */
function assertChain(agent: ScanAgent, expectedChainId: number): void {
  if (agent.chain_id !== expectedChainId) {
    throw new Scan8004Error(
      `8004scan detail endpoint returned agent on chain ${agent.chain_id}, expected ${expectedChainId}.`,
    );
  }
}

function toTrust(a: ScanAgent, asOf: string): TrustData {
  return {
    totalScore: a.total_score,
    averageScore: a.average_score,
    rank: a.rank,
    healthScore: a.health_score,
    totalFeedbacks: a.total_feedbacks ?? 0,
    starCount: a.star_count,
    isVerified: a.is_verified,
    breakdown: a.scores ?? undefined,
    source: '8004scan',
    asOf,
  };
}

function toSummary(a: ScanAgent, asOf: string): AgentSummary {
  const name = a.name ?? `Agent #${a.token_id}`;
  const description = a.description ?? '';
  return {
    id: `${a.chain_id}-${a.token_id}`,
    chainId: a.chain_id,
    tokenId: a.token_id,
    agentId: a.agent_id,
    name,
    description,
    imageUrl: a.image_url,
    owner: a.owner_address,
    category: classify({ metadata: a.metadata, name, description }),
    supportedProtocols: a.supported_protocols ?? [],
    x402Supported: a.x402_supported,
    registeredAt: a.created_at,
    trust: toTrust(a, asOf),
  };
}

function toDetail(a: ScanAgent, expectedChainId: number, asOf: string): AgentDetail {
  assertChain(a, expectedChainId);
  return {
    ...toSummary(a, asOf),
    agentURI: a.agent_uri ?? null,
    agentWallet: a.agent_wallet ?? null,
    metadata: a.metadata ?? null,
    services: a.services ?? null,
  };
}

async function keyedFetch<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`${KEYED_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { accept: 'application/json', [KEY_HEADER]: API_KEY! },
  });
  if (!res.ok) {
    throw new Scan8004Error(`8004scan keyed ${path} responded ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export class Scan8004Source implements AgentIndexSource {
  readonly name = API_KEY ? '8004scan-pro' : '8004scan';

  async listAgents(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    if (API_KEY) return this.listAgentsKeyed(q);
    return this.listAgentsPublic(q);
  }

  /** Keyed surface: server-side chain filter, offset cursor, real per-chain total. */
  private async listAgentsKeyed(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    const limit = q.limit ?? 24;
    const offset = q.cursor ? Number.parseInt(q.cursor, 10) : 0;
    const asOf = new Date().toISOString();

    const res = await keyedFetch<{ items: ScanAgent[]; total: number }>('/agents', {
      chain_id: q.chainId,
      limit,
      offset,
    });

    // Server filters by chain; keep the local filter as defense in depth.
    let items = res.items
      .filter((a) => a.chain_id === q.chainId)
      .map((a) => toSummary(a, asOf));
    if (q.category) items = items.filter((a) => a.category === q.category);

    return {
      items,
      nextCursor: offset + limit < res.total ? String(offset + limit) : null,
      total: res.total,
      asOf,
      source: this.name,
    };
  }

  /** Public surface: chain filters ignored upstream; over-fetch + filter locally. */
  private async listAgentsPublic(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    const page = q.cursor ? Number.parseInt(q.cursor, 10) : 1;
    const limit = q.limit ?? 24;
    const asOf = new Date().toISOString();

    const res = await scanFetch<ScanAgent[]>('/agents', {
      chain_id: q.chainId, // kept: harmless today, correct if upstream fixes it
      page,
      limit: 100,
    });

    let items = res.data
      .filter((a) => a.chain_id === q.chainId)
      .map((a) => toSummary(a, asOf));
    if (q.category) items = items.filter((a) => a.category === q.category);
    items = items.slice(0, limit);

    const pagination = res.meta?.pagination;
    return {
      items,
      nextCursor: pagination?.hasMore ? String(page + 1) : null,
      // Public upstream total is global (all chains); never present it as ours.
      total: null,
      asOf,
      source: this.name,
    };
  }

  async getAgent(chainId: number, tokenId: string): Promise<AgentDetail | null> {
    const asOf = new Date().toISOString();
    if (API_KEY) {
      try {
        // Keyed detail returns the agent object directly (no envelope).
        const agent = await keyedFetch<ScanAgent>(`/agents/${chainId}/${tokenId}`, {});
        return toDetail(agent, chainId, asOf);
      } catch (err) {
        if (err instanceof Scan8004Error && err.status === 404) return null;
        throw err;
      }
    }
    try {
      const res = await scanFetch<ScanAgent>(`/agents/${chainId}/${tokenId}`, {});
      return toDetail(res.data, chainId, asOf);
    } catch (err) {
      if (err instanceof Scan8004Error && err.status === 404) return null;
      throw err;
    }
  }

  async searchAgents(chainId: number, query: string): Promise<AgentSummary[]> {
    const asOf = new Date().toISOString();
    const res = await scanFetch<ScanAgent[]>('/agents/search', {
      q: query,
      chain_id: chainId,
    });
    // Search ignores chain filters upstream as well; filter locally.
    return res.data
      .filter((a) => a.chain_id === chainId)
      .map((a) => toSummary(a, asOf));
  }

  async getFeedback(chainId: number, tokenId: string): Promise<Feedback[]> {
    const registry = ERC8004_REGISTRIES[chainId]?.identity.toLowerCase();
    if (!registry) throw new Scan8004Error(`No ERC-8004 registry known for chain ${chainId}`);
    const res = await scanFetch<Record<string, unknown>[]>('/feedbacks', {
      chain_id: chainId,
      agent_id: `${chainId}:${registry}:${tokenId}`,
    });
    return res.data.map((f) => ({
      agentRef: String(f['agent_id'] ?? `${chainId}-${tokenId}`),
      client: String(f['user_address'] ?? ''),
      score: typeof f['score'] === 'number' ? f['score'] : null,
      value: f['value'] != null ? String(f['value']) : null,
      tags: [f['tag1'], f['tag2']].filter((t): t is string => typeof t === 'string' && t.length > 0),
      uri: f['feedback_uri'] != null ? String(f['feedback_uri']) : null,
      txHash: f['transaction_hash'] != null ? String(f['transaction_hash']) : null,
      blockNumber: typeof f['block_number'] === 'number' ? f['block_number'] : null,
      revoked: f['is_revoked'] === true,
      timestamp: f['created_at'] != null ? String(f['created_at']) : null,
    }));
  }

  async stats(chainId: number): Promise<IndexStats> {
    const asOf = new Date().toISOString();
    const res = await scanFetch<Record<string, unknown>>('/stats', { chain_id: chainId });
    const d = res.data;
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return {
      totalAgents: num(d['total_agents']) ?? num(d['agents']) ?? null,
      totalFeedbacks: num(d['total_feedbacks']) ?? num(d['feedbacks']) ?? null,
      asOf,
      source: this.name,
    };
  }
}
