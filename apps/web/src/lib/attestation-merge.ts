import type { AgentSummary } from '@agripinaa/agent-index';

import type { OnchainAttestation } from './onchain-rep';

/**
 * The upstream indexer lags our ERC-8004 writes, so its score reads 0 for
 * agents we have attested. The registry read is the source of truth, and it
 * has to be applied on every path that renders a score, or the same agent
 * shows two different numbers (hub card vs detail page).
 *
 * Pure on purpose: the chain read stays in onchain-rep.ts, so both list paths
 * share one merge rule and it is testable without a node.
 */
export function mergeAttestation(
  agent: AgentSummary,
  attestation: OnchainAttestation | null,
): AgentSummary {
  if (!attestation) return agent;
  return {
    ...agent,
    trust: {
      ...agent.trust,
      totalScore: attestation.value,
      totalFeedbacks: attestation.count,
    },
  };
}
