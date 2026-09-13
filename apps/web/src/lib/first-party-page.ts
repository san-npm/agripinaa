import type { AgentSummary, Page } from '@agripinaa/agent-index';

import { normalizeAgentId } from './claim-message';

/**
 * The first API page leads with our own agents in the category, as the hub
 * pages do: the registry window is a sample of the newest registrations, and
 * a client reading the API rather than the page would otherwise never see
 * the agents that have a track record here. Deduplicated on the token id, and
 * cut to the requested limit so a page is never longer than asked.
 */
export function leadWithFirstParty(
  page: Page<AgentSummary>,
  firstParty: AgentSummary[],
  limit: number,
): Page<AgentSummary> {
  const pinned = new Set(firstParty.map((a) => normalizeAgentId(a.tokenId)));
  const rest = page.items.filter((a) => !pinned.has(normalizeAgentId(a.tokenId)));
  return { ...page, items: [...firstParty, ...rest].slice(0, limit) };
}
