import type { AgentSummary } from './types';

/**
 * A signal-quality score used to rank the directory. The ERC-8004 registry on
 * BSC is permissionless and full of low-signal registrations (the same name
 * minted dozens of times, no category, no reputation), which flood a naive
 * list. Ranking by real signal surfaces agents a user can actually evaluate
 * and sinks the spam, without hiding anything.
 */
export function qualityScore(a: AgentSummary): number {
  let score = 0;
  if (a.category) score += 40; // classifiable into one of the four hubs
  if (a.trust.isVerified) score += 30;
  if ((a.trust.totalScore ?? 0) > 0) score += 20;
  score += Math.min(a.trust.totalFeedbacks, 10) * 2; // up to +20
  if (a.description && a.description.trim().length > 0) score += 10;
  if (a.imageUrl) score += 5;
  if (a.x402Supported) score += 5;
  return score;
}

/**
 * Deduplicate true duplicates (same name AND same owner, e.g. an agent
 * re-indexed at several token ids) keeping the highest-quality copy, then
 * sort by quality descending with a stable registration-time tiebreak.
 * Distinct owners are never merged: they are genuinely different agents.
 */
export function rankAndDedupe(agents: AgentSummary[]): AgentSummary[] {
  const byKey = new Map<string, AgentSummary>();
  for (const a of agents) {
    const key = `${a.name.trim().toLowerCase()}|${a.owner.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || qualityScore(a) > qualityScore(existing)) byKey.set(key, a);
  }
  return [...byKey.values()].sort((x, y) => {
    const dq = qualityScore(y) - qualityScore(x);
    if (dq !== 0) return dq;
    return (y.registeredAt ?? '').localeCompare(x.registeredAt ?? '');
  });
}
