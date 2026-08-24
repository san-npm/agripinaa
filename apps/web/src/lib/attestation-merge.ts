import type { AgentSummary, TrustData } from '@agripinaa/agent-index';

import type { OnchainAttestation } from './onchain-rep';

/**
 * The upstream indexer lags our ERC-8004 writes, so its score reads 0 for
 * agents we have attested. The registry read is the source of truth, and it
 * has to be applied on every path that renders a score, or the same agent
 * shows two different numbers (hub card vs detail page).
 *
 * The override also moves where those two numbers came from, so it re-tags
 * them. Everything else in the record (rank, health, stars) still comes from
 * the indexer, which is why this sets a per-field `scoreSource` instead of
 * flipping the record-level `source`: no on-chain read produces a rank, and
 * claiming one did would trade one wrong label for another.
 *
 * Pure on purpose: the chain read stays in onchain-rep.ts, so both list paths
 * share one merge rule and it is testable without a node.
 */
export function mergeAttestation<T extends AgentSummary>(
  agent: T,
  attestation: OnchainAttestation | null,
): T {
  if (!attestation) return agent;
  return {
    ...agent,
    trust: {
      ...agent.trust,
      totalScore: attestation.value,
      totalFeedbacks: attestation.count,
      scoreSource: 'registry',
    },
  };
}

/**
 * One line for the freshness stamp. Names both sources when the score and the
 * rest of the record disagree about where they came from, so a reader can tell
 * which number is chain-derived without opening the API response.
 */
export function trustProvenanceLabel(trust: TrustData): string {
  const scoreSource = trust.scoreSource ?? trust.source;
  if (scoreSource === trust.source) return trust.source;
  return `${scoreSource} (score) · ${trust.source} (profile)`;
}
