import 'server-only';

import {
  MergedSource,
  type AgentDetail,
  type AgentSummary,
  type Category,
  type Feedback,
  type IndexStats,
  type Page,
} from '@agripinaa/agent-index';
import { cacheLife } from 'next/cache';

/** The marketplace currently serves BNB Smart Chain mainnet. */
export const CHAIN_ID = 56;

const source = new MergedSource();

/**
 * Agripinaa's own reference agents (ERC-8004 mainnet registrations,
 * 2026-08-18). Pinned into listings because the upstream indexer's BSC
 * lane is rpc_only and lags fresh registrations; profiles for these ids
 * resolve via direct registry reads either way. Provenance stays visible
 * on each card.
 */
const PINNED_AGENT_IDS = ['269703', '269704', '269705', '269706'];

export async function listAgents(
  category?: Category,
  limit = 24,
  cursor?: string,
): Promise<Page<AgentSummary>> {
  'use cache';
  cacheLife('minutes');
  const page = await source.listAgents({ chainId: CHAIN_ID, category, limit, cursor });
  if (cursor) return page; // pin only on the first page

  // Always resolve pinned agents through getAgent (which enriches indexer
  // records from the on-chain manifest), then REPLACE any poorer copies the
  // list already contains, so hubs never regress to "Agent #NNN" entries.
  const pinned = (
    await Promise.all(
      PINNED_AGENT_IDS.map((id) => source.getAgent(CHAIN_ID, id).catch(() => null)),
    )
  )
    .filter((a): a is NonNullable<typeof a> => a != null)
    .filter((a) => (category ? a.category === category : true));
  if (pinned.length === 0) return page;
  const pinnedIds = new Set(pinned.map((a) => a.tokenId));
  return {
    ...page,
    items: [...pinned, ...page.items.filter((a) => !pinnedIds.has(a.tokenId))],
  };
}

export async function getAgent(tokenId: string): Promise<AgentDetail | null> {
  'use cache';
  cacheLife('minutes');
  return source.getAgent(CHAIN_ID, tokenId);
}

export async function getFeedback(tokenId: string): Promise<Feedback[]> {
  'use cache';
  cacheLife('minutes');
  return source.getFeedback(CHAIN_ID, tokenId);
}

export async function getStats(): Promise<IndexStats> {
  'use cache';
  cacheLife('minutes');
  return source.stats(CHAIN_ID);
}
