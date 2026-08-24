import { AGENT_LIST, type AgentCategory, type AgentRecord, type AgentSlug } from './agents';

export type ProofAgentSlug = AgentSlug;

export type ProofCategory = AgentCategory;

export type ProofKind = 'trade' | 'repair' | 'rotate' | 'rebalance' | 'mint';

export interface ProofAgent {
  slug: ProofAgentSlug;
  tokenId: string;
  name: string;
  category: ProofCategory;
  wallet: `0x${string}`;
  backfillOphisTrades: boolean;
}

/** Registered agents only: no token id means nothing to attribute a proof to. */
function toProofAgent(record: AgentRecord): ProofAgent | null {
  if (record.tokenId === null) return null;
  return {
    slug: record.slug,
    tokenId: record.tokenId,
    name: record.name,
    category: record.category,
    wallet: record.wallet,
    backfillOphisTrades: record.backfillOphisTrades,
  };
}

/**
 * The only identities allowed into the public proof feed, projected from the
 * shared agent registry so a new agent cannot reach the feed without a record
 * (and cannot reach it before it is registered on-chain). Wallets are public
 * ERC-8004 agent wallets (never signer secrets) and are also the owners used
 * for Ophis settlement backfill.
 */
export const PROOF_AGENT_LIST: ProofAgent[] = AGENT_LIST.map(toProofAgent).filter(
  (agent): agent is ProofAgent => agent !== null,
);

export const PROOF_AGENTS: Partial<Record<ProofAgentSlug, ProofAgent>> = Object.fromEntries(
  PROOF_AGENT_LIST.map((agent) => [agent.slug, agent]),
);

export interface ProofEvent {
  id: string;
  /** ERC-8004 token id. */
  agent: string;
  agentName: string;
  category: ProofCategory;
  kind: ProofKind;
  summary: string;
  txHash?: `0x${string}`;
  orderUid?: `0x${string}`;
  surplusBps?: number;
  hf?: number;
  at: string;
}

export interface ProofFeedPayload {
  events: ProofEvent[];
  asOf: string;
  source: 'runner' | 'runner+chain' | 'chain' | 'none';
}
