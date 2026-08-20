export type ProofAgentSlug = 'grid' | 'health-factor' | 'yield' | 'lp-range';

export type ProofCategory = 'grid' | 'health-factor' | 'yield' | 'rebalancing';

export type ProofKind = 'trade' | 'repair' | 'rotate' | 'rebalance' | 'mint';

export interface ProofAgent {
  slug: ProofAgentSlug;
  tokenId: string;
  name: string;
  category: ProofCategory;
  wallet: `0x${string}`;
  backfillOphisTrades: boolean;
}

/**
 * The only identities allowed into the public proof feed. Wallets are public
 * ERC-8004 agent wallets (never signer secrets) and are also the owners used
 * for Ophis settlement backfill.
 */
export const PROOF_AGENTS: Record<ProofAgentSlug, ProofAgent> = {
  grid: {
    slug: 'grid',
    tokenId: '269703',
    name: 'Agripinaa Grid',
    category: 'grid',
    wallet: '0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A',
    backfillOphisTrades: true,
  },
  'health-factor': {
    slug: 'health-factor',
    tokenId: '269704',
    name: 'Agripinaa Guardian',
    category: 'health-factor',
    wallet: '0x7d2dCB4eD1a90B992B34C114C924c5643B461DFF',
    backfillOphisTrades: false,
  },
  yield: {
    slug: 'yield',
    tokenId: '269705',
    name: 'Agripinaa Harvester',
    category: 'yield',
    wallet: '0x344eF980A827e9FF4086Ee95b22aeD0D95d11ac9',
    backfillOphisTrades: false,
  },
  'lp-range': {
    slug: 'lp-range',
    tokenId: '269706',
    name: 'Agripinaa Ranger',
    category: 'rebalancing',
    wallet: '0x79827EF1faDeA3B30A8E77fdbaF17944298A3bB6',
    backfillOphisTrades: true,
  },
};

export const PROOF_AGENT_LIST = Object.values(PROOF_AGENTS);

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
