import 'server-only';

import {
  MergedSource,
  rankAndDedupe,
  type AgentDetail,
  type AgentSummary,
  type Category,
  type Feedback,
  type IndexStats,
  type Page,
} from '@agripinaa/agent-index';
import { cacheLife } from 'next/cache';

import { getOnchainAttestation } from './onchain-rep';

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

export interface Directory {
  verified: AgentSummary[];
  registry: AgentSummary[];
  registrySource: string;
  asOf: string;
}

/**
 * The marketplace split: our proven agents ("verified", with on-chain
 * execution + attestation) kept separate from the unverified ERC-8004
 * registry long tail. We list the registry for discovery (the brief is a
 * front door for every agent) but never imply we vouch for it.
 */
export async function listDirectory(category?: Category): Promise<Directory> {
  'use cache';
  cacheLife('minutes');
  const raw = await source.listAgents({ chainId: CHAIN_ID, category, limit: 100 });
  const verified = (
    await Promise.all(
      PINNED_AGENT_IDS.map((id) => source.getAgent(CHAIN_ID, id).catch(() => null)),
    )
  )
    .filter((a): a is NonNullable<typeof a> => a != null)
    .filter((a) => (category ? a.category === category : true));
  // Reflect the on-chain ERC-8004 attestation on verified cards (the indexer
  // lags our writes, so its score/feedback read 0 despite the attestation).
  const enriched = await Promise.all(
    verified.map(async (a) => {
      const att = await getOnchainAttestation(a.tokenId).catch(() => null);
      return att
        ? { ...a, trust: { ...a.trust, totalScore: att.value, totalFeedbacks: att.count } }
        : a;
    }),
  );
  const verifiedIds = new Set(enriched.map((a) => a.tokenId));
  const registry = rankAndDedupe(raw.items).filter((a) => !verifiedIds.has(a.tokenId));
  return { verified: enriched, registry, registrySource: raw.source, asOf: new Date().toISOString() };
}

export async function listAgents(
  category?: Category,
  limit = 24,
  cursor?: string,
): Promise<Page<AgentSummary>> {
  'use cache';
  cacheLife('minutes');
  // Over-fetch so ranking/dedupe has a real sample to work on (the registry
  // is flooded with low-signal duplicate registrations); then rank by quality
  // and collapse true duplicates before slicing to the requested page.
  const raw = await source.listAgents({ chainId: CHAIN_ID, category, limit: 100, cursor });
  const ranked = rankAndDedupe(raw.items);

  if (cursor) {
    return { ...raw, items: ranked.slice(0, limit) };
  }

  // Pinned reference agents resolve through getAgent (enriched from the
  // on-chain manifest) and always lead, replacing any poorer copy in the list.
  const pinned = (
    await Promise.all(
      PINNED_AGENT_IDS.map((id) => source.getAgent(CHAIN_ID, id).catch(() => null)),
    )
  )
    .filter((a): a is NonNullable<typeof a> => a != null)
    .filter((a) => (category ? a.category === category : true));
  const pinnedIds = new Set(pinned.map((a) => a.tokenId));
  const items = [...pinned, ...ranked.filter((a) => !pinnedIds.has(a.tokenId))].slice(0, limit);
  return { ...raw, items };
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
