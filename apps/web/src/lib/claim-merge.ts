import {
  CATEGORIES,
  type AgentSummary,
  type Category,
  type ClaimedField,
} from '@agripinaa/agent-index';

import type { ClaimRecord } from './claims';

/**
 * How an owner's signed claim meets an indexed registration.
 *
 * The rule is one-directional: on-chain metadata always wins, and a claim can
 * only fill a gap the registration left. An owner who wants their listing to
 * read differently changes their agentURI document; the claim store is for the
 * registrations that carry no document at all, which is most of the registry.
 *
 * The same rule decides placement: a hub takes a claimed agent only when the
 * merged record actually reads as that category, so a claim can never win a
 * spot on a page that would then show a different chip.
 *
 * Pure, and free of `server-only`: the KV read stays in claims.ts, so every
 * path that renders a listing (both hubs, the directory, the detail page)
 * shares one merge rule, cards can import the label, and both are testable
 * without a store. Same shape as `attestation-merge.ts` for the same reasons.
 */

/** Field order for `claimedFields` and the label built from it. */
const FIELD_ORDER: ClaimedField[] = ['description', 'category', 'website', 'endpoint'];

/**
 * Fill the blanks on an indexed listing from its owner's claim.
 *
 * Returns the same object when there is no claim, so a caller can tell a merged
 * record from an untouched one by identity. `claimed` is set whenever a claim
 * exists, even when it filled nothing: the owner did sign for this identity,
 * and the entry point that offers the claim form keys off that.
 *
 * Staleness is not decided here. A claim proves ownership at signing time only,
 * so a caller that knows the current owner drops a claim left behind by a
 * transfer (`claimIsStale`) before it gets this far.
 */
export function applyClaim<T extends AgentSummary>(
  agent: T,
  claim: ClaimRecord | null,
): T {
  if (!claim) return agent;
  const fields = claim.fields;
  const claimedFields: ClaimedField[] = [];
  const filled: Partial<AgentSummary> = {};

  const description = text(fields?.description);
  if (description && !text(agent.description)) {
    filled.description = description;
    claimedFields.push('description');
  }

  // 'other' is what the claim form stores for "none of the four hubs", so it
  // classifies nothing rather than inventing a category.
  const category = CATEGORIES.find((c) => c === fields?.category) ?? null;
  if (category && agent.category == null) {
    filled.category = category;
    claimedFields.push('category');
  }

  const website = text(fields?.website);
  if (website && !text(agent.website)) {
    filled.website = website;
    claimedFields.push('website');
  }

  const endpoint = text(fields?.endpoint);
  if (endpoint && !text(agent.endpoint)) {
    filled.endpoint = endpoint;
    claimedFields.push('endpoint');
  }

  return { ...agent, ...filled, claimed: true, claimedFields };
}

/**
 * Merge a claim for one category hub, or return null when the merged record
 * does not belong there.
 *
 * A caller decides whether the active listing source already contains the
 * record. Native metadata alone is not proof of that: the list can lag or fall
 * back to a snapshot while the detail/registry lookup resolves a fresher
 * registration. Metadata still wins the merge, so a native `grid` record
 * cannot be placed in `yield`; it can only be preserved in `grid` when the
 * listing source is known to have missed it. `other` classifies nothing.
 */
export function claimForCategory<T extends AgentSummary>(
  agent: T,
  claim: ClaimRecord,
  category: Category,
): T | null {
  if (claim.fields.category !== category) return null;
  const merged = applyClaim(agent, claim);
  return merged.category === category ? merged : null;
}

/**
 * How many claimed agents a hub page of `pageSize` may lead with.
 *
 * They have to lead, or a page that slices to its size would never reach them:
 * they are absent from the upstream ranked list, which is why the hub resolves
 * them separately. They must not lead in bulk either, because they arrive in
 * claim order with no ranking behind them, so a category that collects many
 * claims would otherwise push every indexed registration off its own hub. A
 * third of the page is theirs and the ranked registrations keep the rest; a
 * page too small to divide still shows one.
 */
export function claimedHubSlots(pageSize: number): number {
  return Math.max(1, Math.floor(pageSize / 3));
}

/**
 * One line for the provenance stamp under owner-provided text, or null when
 * there is none to label. Names the fields rather than the record, so a reader
 * can tell which part of a profile its owner wrote and which part came off the
 * chain, the way `trustProvenanceLabel` splits a score from a profile.
 */
export function claimProvenanceLabel(agent: AgentSummary): string | null {
  const fields = FIELD_ORDER.filter((f) => agent.claimedFields?.includes(f));
  if (!agent.claimed || fields.length === 0) return null;
  return `owner-provided: ${fields.join(', ')}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
