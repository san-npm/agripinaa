export const CATEGORIES = [
  'rebalancing',
  'grid',
  'yield',
  'health-factor',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Trust data is provenance-tagged: consumers always know whether a number
 * came from the 8004scan aggregator or from a direct registry read, and when
 * it was fetched. The UI surfaces both (data-quality judging criterion).
 */
export interface TrustData {
  totalScore: number | null;
  averageScore: number | null;
  rank: number | null;
  healthScore: number | null;
  totalFeedbacks: number;
  starCount: number | null;
  isVerified: boolean;
  /** Per-dimension breakdown (quality, popularity, activity, …) when available. */
  breakdown?: Record<string, number>;
  source: '8004scan' | 'registry';
  asOf: string;
}

export interface AgentSummary {
  /** Stable id: `${chainId}-${tokenId}` (subgraph-shaped). */
  id: string;
  chainId: number;
  tokenId: string;
  /** CAIP-flavored id from the registry, e.g. "56:0x8004a169…:258526". */
  agentId: string;
  name: string;
  description: string;
  imageUrl: string | null;
  owner: string;
  category: Category | null;
  supportedProtocols: string[];
  x402Supported: boolean;
  registeredAt: string | null;
  trust: TrustData;
  /**
   * When >1, this card represents a cluster of indistinguishable low-signal
   * registrations that share this name (distinct owners, no category / score /
   * description). Collapsed for a legible directory; the count is shown.
   */
  duplicateCount?: number;
}

export interface AgentDetail extends AgentSummary {
  agentURI: string | null;
  agentWallet: string | null;
  /** Raw metadata document fetched from agentURI, when resolvable. */
  metadata: Record<string, unknown> | null;
  services: unknown[] | null;
}

export interface Feedback {
  agentRef: string;
  client: string;
  score: number | null;
  value: string | null;
  tags: string[];
  uri: string | null;
  txHash: string | null;
  blockNumber: number | null;
  revoked: boolean;
  timestamp: string | null;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor; null when exhausted. */
  nextCursor: string | null;
  /** Total item count upstream, when the source reports one. */
  total: number | null;
  asOf: string;
  source: string;
}

export interface IndexStats {
  totalAgents: number | null;
  totalFeedbacks: number | null;
  asOf: string;
  source: string;
}

export interface ListAgentsQuery {
  chainId: number;
  category?: Category;
  cursor?: string;
  limit?: number;
}
