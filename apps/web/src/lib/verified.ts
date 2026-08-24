import type { Category } from "@agripinaa/agent-index";
import { AGENT_LIST, type AgentRecord, type ExecutionProof } from "@agripinaa/shared/agents";

export type { ExecutionProof };

export interface VerifiedAgent {
  tokenId: string;
  name: string;
  category: Category;
  registrationTx: string;
  attestation: {
    txHash: string;
    verifier: string;
    tag: string;
    feedbackHash: string;
  };
  proofs: ExecutionProof[];
}

/**
 * A registry record earns a verified listing only once all three on-chain
 * artifacts exist: the ERC-8004 registration, the identity it minted, and the
 * reputation attestation our verifier wrote against it. An agent that is
 * configured but not yet registered has `tokenId: null` and is filtered out
 * here rather than showing a badge it has not earned.
 */
function toVerifiedAgent(agent: AgentRecord): VerifiedAgent | null {
  const { tokenId, registrationTx, attestation } = agent;
  if (tokenId == null || registrationTx == null || attestation == null) return null;
  return {
    tokenId,
    name: agent.name,
    category: agent.category,
    registrationTx,
    attestation,
    proofs: agent.proofs,
  };
}

/**
 * First-party proof records for the agents Agripinaa built, ran, and verified
 * on BSC mainnet. Every reference here is an on-chain artifact anyone can
 * check: the ERC-8004 registration, the reputation attestation, and the
 * agent's real execution. This is what "verified" means on this marketplace,
 * as distinct from the unverified registry long tail.
 *
 * Keyed by token id because that is what a page route carries; the underlying
 * records live in @agripinaa/shared so the runner, the funding plan, and this
 * listing cannot drift apart.
 */
export const VERIFIED_AGENTS: Record<string, VerifiedAgent> = Object.fromEntries(
  AGENT_LIST.map(toVerifiedAgent)
    .filter((agent): agent is VerifiedAgent => agent != null)
    .map((agent) => [agent.tokenId, agent]),
);

export function isVerified(tokenId: string): boolean {
  return tokenId in VERIFIED_AGENTS;
}

export const VERIFIED_IDS = Object.keys(VERIFIED_AGENTS);
