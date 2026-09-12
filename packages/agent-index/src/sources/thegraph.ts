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

const GATEWAY_BASE =
  process.env.GRAPH_GATEWAY_BASE ?? 'https://gateway.thegraph.com/api/subgraphs/id';
const API_KEY = process.env.GRAPH_API_KEY;

/** Same reasoning as the 8004scan deadline: a quiet socket must not hold a render. */
const REQUEST_TIMEOUT_MS = (() => {
  const configured = Number(process.env.GRAPH_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
})();

export class TheGraphError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
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
  const res = await fetch(`${GATEWAY_BASE}/${subgraph}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new TheGraphError(`gateway responded ${res.status}`, res.status);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new TheGraphError(json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new TheGraphError('gateway answered without data');
  return json.data;
}

function isoFromSeconds(s: string | null | undefined): string | null {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** The labels 8004scan uses for the same endpoints, so the two lanes agree in the UI. */
function protocols(f: GqlRegistrationFile | null): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (f.mcpEndpoint) out.push('MCP');
  if (f.a2aEndpoint) out.push('A2A');
  if (f.hasOASF) out.push('OASF');
  if (f.webEndpoint) out.push('Web');
  if (f.emailEndpoint) out.push('Email');
  return out;
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
    services: f
      ? (
          [
            ['MCP', f.mcpEndpoint],
            ['A2A', f.a2aEndpoint],
            ['Web', f.webEndpoint],
            ['Email', f.emailEndpoint],
          ] as const
        )
          .filter(([, endpoint]) => endpoint)
          .map(([name, endpoint]) => ({ name, endpoint }))
      : null,
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
   * matches than it wanted still advances.
   */
  async listAgents(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    const limit = q.limit ?? 24;
    const first = q.category ? 100 : limit;
    const asOf = new Date().toISOString();
    const where = q.cursor ? { agentId_lt: q.cursor } : {};
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
    const nextCursor =
      items.length === limit
        ? items[limit - 1]!.tokenId
        : exhausted
          ? null
          : scanned[scanned.length - 1]!.tokenId;
    return { items, nextCursor, total: null, asOf, source: this.name };
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
   * Aggregations answer newest-first by default, so `first: 1` is the total.
   */
  async stats(chainId: number): Promise<IndexStats> {
    const asOf = new Date().toISOString();
    const data = await gql<{
      protocolAgentStats_collection: { agentRegistrations: string }[];
      protocolFeedbackStats_collection: { feedbackCreated: string }[];
    }>(
      chainId,
      `{
        protocolAgentStats_collection(interval: day, first: 1) { agentRegistrations }
        protocolFeedbackStats_collection(interval: day, first: 1) { feedbackCreated }
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
