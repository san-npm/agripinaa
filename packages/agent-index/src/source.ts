import type {
  AgentDetail,
  AgentSummary,
  Feedback,
  IndexStats,
  ListAgentsQuery,
  Page,
} from './types';

/**
 * SEAM: the agent-index data layer.
 *
 * Deliberately subgraph-shaped (cursor pagination, stable string ids, ISO
 * timestamps) so a Graph subgraph implementation can replace the current
 * 8004scan/registry sources behind the same interface without touching the
 * app.
 */
export interface AgentIndexSource {
  readonly name: string;
  listAgents(q: ListAgentsQuery): Promise<Page<AgentSummary>>;
  getAgent(chainId: number, tokenId: string): Promise<AgentDetail | null>;
  searchAgents(chainId: number, query: string): Promise<AgentSummary[]>;
  getFeedback(chainId: number, tokenId: string): Promise<Feedback[]>;
  stats(chainId: number): Promise<IndexStats>;
}
