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
 * Whether an agent earns its own card in a list. A category or real
 * reputation (a score, feedback, or verification) makes it individually
 * evaluable; a description or an x402 flag alone does not (a publisher can
 * mint the same described agent dozens of times, as Ave.ai does).
 *
 * Exported because a consumer that de-duplicates across several pages has to
 * know which cards `rankAndDedupe` may collapse into a name cluster: those
 * change representative as more pages join the set, so their identity for
 * "already shown" is the name, not the id.
 */
export function isIndividuallyNotable(a: AgentSummary): boolean {
  return (
    a.category != null ||
    a.trust.isVerified ||
    (a.trust.totalScore ?? 0) > 0 ||
    a.trust.totalFeedbacks > 0
  );
}

/**
 * Produce a legible directory from a raw registry sample:
 *   1. Drop exact duplicates (same name AND owner, e.g. re-indexed token ids),
 *      keeping the highest-quality copy.
 *   2. Collapse clusters of indistinguishable low-signal registrations that
 *      share a name (distinct owners, no category / score / description) into
 *      one representative card carrying a duplicateCount. This is not hiding
 *      evaluable data: none of them have any.
 *   3. Rank by quality descending, registration-time tiebreak.
 * Agents with any real signal are never collapsed across owners.
 */
export function rankAndDedupe(agents: AgentSummary[]): AgentSummary[] {
  const byKey = new Map<string, AgentSummary>();
  for (const a of agents) {
    const key = `${a.name.trim().toLowerCase()}|${a.owner.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || qualityScore(a) > qualityScore(existing)) byKey.set(key, a);
  }

  const evaluable: AgentSummary[] = [];
  const lowByName = new Map<string, AgentSummary[]>();
  for (const a of byKey.values()) {
    if (isIndividuallyNotable(a)) {
      evaluable.push(a);
    } else {
      const name = a.name.trim().toLowerCase();
      (lowByName.get(name) ?? lowByName.set(name, []).get(name)!).push(a);
    }
  }
  const collapsed: AgentSummary[] = [...lowByName.values()].map((group) => {
    const rep = group.reduce((a, b) =>
      (b.registeredAt ?? '') > (a.registeredAt ?? '') ? b : a,
    );
    return group.length > 1 ? { ...rep, duplicateCount: group.length } : rep;
  });

  return [...evaluable, ...collapsed].sort((x, y) => {
    const dq = qualityScore(y) - qualityScore(x);
    if (dq !== 0) return dq;
    return (y.registeredAt ?? '').localeCompare(x.registeredAt ?? '');
  });
}
