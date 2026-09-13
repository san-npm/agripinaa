/**
 * One request to a subgraph on The Graph Network through the gateway.
 *
 * Shared by the agent index (Agent0's ERC-8004 subgraph) and the yield agents
 * (Messari's lending subgraphs): the same bearer header, the same deadline,
 * the same three ways an answer is not an answer. The gateway refuses
 * unauthenticated queries, so a missing key is the caller's decision to make
 * before calling this.
 */
export const GRAPH_GATEWAY_BASE = 'https://gateway.thegraph.com/api/subgraphs/id';

export interface GraphQueryOptions {
  apiKey: string;
  /** Overridable for tests that stub the gateway. */
  gatewayBase?: string;
  timeoutMs?: number;
}

export async function graphQuery<T>(
  subgraphId: string,
  query: string,
  variables: Record<string, unknown>,
  opts: GraphQueryOptions,
): Promise<T> {
  const res = await fetch(`${opts.gatewayBase ?? GRAPH_GATEWAY_BASE}/${subgraphId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`graph gateway responded ${res.status} for ${subgraphId}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`graph gateway: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error('graph gateway answered without data');
  return json.data;
}
