import { ERC8004_REGISTRIES, graphQuery } from '@agripinaa/shared';

import { classify } from '../classify';
import type { AgentIndexSource } from '../source';
import type {
  AgentDetail,
  AgentSummary,
  Feedback,
  IndexStats,
  ListAgentsQuery,
  Page,
} from '../types';

/**
 * The Graph lane: Agent0's ERC-8004 subgraphs, one deployment per chain,
 * queried through The Graph Gateway.
 *
 * Pinned by subgraph id, verified 2026-09-12 against
 * github.com/agent0lab/subgraph (README "Supported Networks"). The gateway
 * refuses unauthenticated queries ("auth error: missing authorization
 * header"), so this source is only constructed when `GRAPH_API_KEY` is set; a
 * Subgraph Studio key on the free tier is enough.
 */
export const AGENT0_SUBGRAPHS: Record<number, string> = {
  56: 'D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K',
  97: 'BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z',
};

const GATEWAY_BASE = process.env.GRAPH_GATEWAY_BASE;
const API_KEY = process.env.GRAPH_API_KEY;

/** A list cursor this lane issued: `g` and the agentId to continue below. */
export function isGraphCursor(cursor: string): boolean {
  return /^g\d{1,18}$/.test(cursor);
}

export class TheGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TheGraphError';
  }
}

interface GqlRegistrationFile {
  name: string | null;
  description: string | null;
  image: string | null;
  active: boolean | null;
  x402Support: boolean | null;
  mcpEndpoint: string | null;
  a2aEndpoint: string | null;
  webEndpoint: string | null;
  emailEndpoint: string | null;
  hasOASF: boolean;
  oasfSkills: string[];
  oasfDomains: string[];
  ens: string | null;
  did: string | null;
}

interface GqlAgent {
  id: string;
  agentId: string;
  agentURI: string | null;
  owner: string;
  agentWallet: string | null;
  createdAt: string;
  totalFeedback: string;
  registrationFile: GqlRegistrationFile | null;
}

interface GqlFeedback {
  id: string;
  clientAddress: string;
  value: string;
  tag1: string | null;
  tag2: string | null;
  feedbackURI: string | null;
  isRevoked: boolean;
  createdAt: string;
}

const AGENT_FIELDS = `
  id agentId agentURI owner agentWallet createdAt totalFeedback
  registrationFile {
    name description image active x402Support
    mcpEndpoint a2aEndpoint webEndpoint emailEndpoint
    hasOASF oasfSkills oasfDomains ens did
  }`;

async function gql<T>(
  chainId: number,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const subgraph = AGENT0_SUBGRAPHS[chainId];
  if (!subgraph) throw new TheGraphError(`no Agent0 subgraph pinned for chain ${chainId}`);
  try {
    return await graphQuery<T>(subgraph, query, variables, { apiKey: API_KEY!, gatewayBase: GATEWAY_BASE });
  } catch (err) {
    throw new TheGraphError(err instanceof Error ? err.message : String(err));
  }
}

function isoFromSeconds(s: string | null | undefined): string | null {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** The registration file's endpoints under the labels 8004scan uses, so the two lanes agree in the UI. */
const ENDPOINTS = [
  ['MCP', 'mcpEndpoint'],
  ['A2A', 'a2aEndpoint'],
  ['Web', 'webEndpoint'],
  ['Email', 'emailEndpoint'],
] as const;

function services(f: GqlRegistrationFile | null): { name: string; endpoint: string }[] {
  if (!f) return [];
  return ENDPOINTS.flatMap(([name, key]) => (f[key] ? [{ name, endpoint: f[key]! }] : []));
}

function protocols(f: GqlRegistrationFile | null): string[] {
  const present = new Set(services(f).map((s) => s.name));
  if (f?.hasOASF) present.add('OASF');
  return ['MCP', 'A2A', 'OASF', 'Web', 'Email'].filter((name) => present.has(name));
}

function toSummary(a: GqlAgent, chainId: number, asOf: string): AgentSummary {
  const tokenId = a.agentId;
  const f = a.registrationFile;
  const name = f?.name ?? `Agent #${tokenId}`;
  const description = f?.description ?? '';
  const identity = ERC8004_REGISTRIES[chainId]?.identity.toLowerCase();
  return {
    id: `${chainId}-${tokenId}`,
    chainId,
    tokenId,
    agentId: identity ? `${chainId}:${identity}:${tokenId}` : a.id,
    name,
    description,
    imageUrl: f?.image ?? null,
    owner: a.owner,
    category: classify({
      name,
      description,
      extraText: [...(f?.oasfSkills ?? []), ...(f?.oasfDomains ?? [])].join(' '),
    }),
    supportedProtocols: protocols(f),
    x402Supported: f?.x402Support === true,
    agentWallet: a.agentWallet,
    registeredAt: isoFromSeconds(a.createdAt),
    trust: {
      totalScore: null,
      averageScore: null,
      rank: null,
      healthScore: null,
      totalFeedbacks: Number(a.totalFeedback) || 0,
      starCount: null,
      // No ValidationRegistry is deployed on BSC; the subgraph indexes one
      // but it has nothing to say, so nothing here is "verified".
      isVerified: false,
      source: 'the-graph',
      asOf,
    },
  };
}

function toDetail(a: GqlAgent, chainId: number, asOf: string): AgentDetail {
  const f = a.registrationFile;
  return {
    ...toSummary(a, chainId, asOf),
    agentURI: a.agentURI,
    agentWallet: a.agentWallet,
    // The subgraph stores the registration file's known fields, not the raw
    // document. Expose those under the names the document uses; the merged
    // source still enriches from the chain when this is placeholder-thin.
    metadata: f
      ? {
          name: f.name,
          description: f.description,
          image: f.image,
          active: f.active,
          x402Support: f.x402Support,
          ens: f.ens,
          did: f.did,
        }
      : null,
    services: f ? services(f) : null,
  };
}

export class TheGraphSource implements AgentIndexSource {
  readonly name = 'the-graph';

  /** True when a gateway key is configured; the merged source skips the lane otherwise. */
  static configured(): boolean {
    return Boolean(API_KEY);
  }

  /**
   * Newest first, keyed on the numeric agentId rather than `skip`: the
   * gateway caps `skip` at 5000 and the BSC registry is far past that. The
   * cursor is the last agentId scanned, so a category page that found fewer
   * matches than it wanted still advances. It is tagged `g<agentId>` so the
   * merged source never hands it to a lane that would read it as an offset.
   */
  async listAgents(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    const limit = q.limit ?? 24;
    const first = q.category ? 100 : limit;
    const asOf = new Date().toISOString();
    if (q.cursor !== undefined && !isGraphCursor(q.cursor)) {
      throw new TheGraphError(`cursor ${q.cursor} was issued by another index lane`);
    }
    const where = q.cursor ? { agentId_lt: q.cursor.slice(1) } : {};
    const { agents } = await gql<{ agents: GqlAgent[] }>(
      q.chainId,
      `query List($first: Int!, $where: Agent_filter) {
        agents(first: $first, where: $where, orderBy: agentId, orderDirection: desc) { ${AGENT_FIELDS} }
      }`,
      { first, where },
    );
    const scanned = agents.map((a) => toSummary(a, q.chainId, asOf));
    const matching = q.category ? scanned.filter((a) => a.category === q.category) : scanned;
    const items = matching.slice(0, limit);
    const exhausted = agents.length < first;
    const last =
      items.length === limit
        ? items[limit - 1]!.tokenId
        : exhausted
          ? null
          : scanned[scanned.length - 1]!.tokenId;
    return { items, nextCursor: last === null ? null : `g${last}`, total: null, asOf, source: this.name };
  }

  async getAgent(chainId: number, tokenId: string): Promise<AgentDetail | null> {
    const asOf = new Date().toISOString();
    const { agent } = await gql<{ agent: GqlAgent | null }>(
      chainId,
      `query Get($id: ID!) { agent(id: $id) { ${AGENT_FIELDS} } }`,
      { id: `${chainId}:${tokenId}` },
    );
    return agent ? toDetail(agent, chainId, asOf) : null;
  }

  async searchAgents(chainId: number, query: string): Promise<AgentSummary[]> {
    const asOf = new Date().toISOString();
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    const { agents } = await gql<{ agents: GqlAgent[] }>(
      chainId,
      `query Search($q: String!) {
        agents(first: 50, orderBy: agentId, orderDirection: desc, where: {
          or: [
            { registrationFile_: { name_contains_nocase: $q } },
            { registrationFile_: { description_contains_nocase: $q } }
          ]
        }) { ${AGENT_FIELDS} }
      }`,
      { q },
    );
    return agents.map((a) => toSummary(a, chainId, asOf));
  }

  async getFeedback(chainId: number, tokenId: string): Promise<Feedback[]> {
    const { feedbacks } = await gql<{ feedbacks: GqlFeedback[] }>(
      chainId,
      `query Feedback($agent: String!) {
        feedbacks(first: 20, where: { agent: $agent }, orderBy: createdAt, orderDirection: desc) {
          id clientAddress value tag1 tag2 feedbackURI isRevoked createdAt
        }
      }`,
      { agent: `${chainId}:${tokenId}` },
    );
    return feedbacks.map((f) => {
      // `value` is already rawValue / 10^valueDecimals: the subgraph's
      // reputation-registry mapping applies the decimals before storing the
      // BigDecimal (agent0lab/subgraph src/reputation-registry.ts,
      // computeFeedbackValue), so this is the score as the client meant it.
      const score = Number(f.value);
      return {
        agentRef: `${chainId}-${tokenId}`,
        client: f.clientAddress,
        score: Number.isFinite(score) ? score : null,
        value: f.value,
        tags: [f.tag1, f.tag2].filter((t): t is string => typeof t === 'string' && t.length > 0),
        uri: f.feedbackURI,
        // The subgraph keys feedback on (agent, client, index), not on the tx.
        txHash: null,
        blockNumber: null,
        revoked: f.isRevoked,
        timestamp: isoFromSeconds(f.createdAt),
      };
    });
  }

  /**
   * Cumulative daily rollups: the newest bucket carries the running total.
   * Ordered by bucket timestamp explicitly rather than relying on the
   * collection's default order (verified live 2026-09-13 that the gateway
   * accepts orderBy on aggregations and that the default agrees).
   */
  async stats(chainId: number): Promise<IndexStats> {
    const asOf = new Date().toISOString();
    const data = await gql<{
      protocolAgentStats_collection: { agentRegistrations: string }[];
      protocolFeedbackStats_collection: { feedbackCreated: string }[];
    }>(
      chainId,
      `{
        protocolAgentStats_collection(interval: day, first: 1, orderBy: timestamp, orderDirection: desc) { agentRegistrations }
        protocolFeedbackStats_collection(interval: day, first: 1, orderBy: timestamp, orderDirection: desc) { feedbackCreated }
      }`,
      {},
    );
    const num = (v: string | undefined): number | null => {
      const n = Number(v);
      return v != null && Number.isFinite(n) ? n : null;
    };
    return {
      totalAgents: num(data.protocolAgentStats_collection[0]?.agentRegistrations),
      // One subgraph deployment per chain: every number here is this chain's.
      chainScoped: true,
      totalFeedbacks: num(data.protocolFeedbackStats_collection[0]?.feedbackCreated),
      asOf,
      source: this.name,
    };
  }
}
