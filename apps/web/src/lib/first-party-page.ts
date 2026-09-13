import type { AgentSummary, Page } from '@agripinaa/agent-index';

import { normalizeAgentId } from './claim-message';

/**
 * The first API page leads with our own agents in the category, as the hub
 * pages do: the registry window is a sample of the newest registrations, and
 * a client reading the API rather than the page would otherwise never see
 * the agents that have a track record here. Deduplicated on the token id.
 * The window's own items are all kept: the cursor was cut for them, and
 * trimming the page to the limit would skip whatever fell off its end.
 * So the first page may be longer than `limit` by the number of first-party
 * agents, which the OpenAPI document says.
 */
export function leadWithFirstParty(page: Page<AgentSummary>, firstParty: AgentSummary[]): Page<AgentSummary> {
  const pinned = new Set(firstParty.map((a) => normalizeAgentId(a.tokenId)));
  const rest = page.items.filter((a) => !pinned.has(normalizeAgentId(a.tokenId)));
  return { ...page, items: [...firstParty, ...rest] };
}
