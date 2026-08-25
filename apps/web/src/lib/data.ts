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
import { AGENT_LIST } from '@agripinaa/shared/agents';
import { cacheLife } from 'next/cache';

import { mergeAttestation } from './attestation-merge';
import { applyClaim } from './claim-merge';
import {
  claimIsStale,
  getClaim,
  listClaims,
  normalizeAgentId,
  type ClaimRecord,
} from './claims';
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
 *
 * Read off the shared registry rather than restated here, so registering a new
 * agent pins it automatically. Records with no `tokenId` are not on-chain yet
 * and have nothing for `getAgent` to resolve, so they drop out.
 */
const PINNED_AGENT_IDS = AGENT_LIST.map((agent) => agent.tokenId).filter(
  (id): id is string => id != null,
);

/**
 * Reflect the on-chain ERC-8004 attestation on every card that renders a
 * score. Used by both list paths so a category hub and a detail page cannot
 * disagree about the same agent. A failed read leaves the indexer value in
 * place rather than blanking the card.
 */
export async function withOnchainAttestation(
  agents: AgentSummary[],
): Promise<AgentSummary[]> {
  return Promise.all(
    agents.map(async (a) =>
      mergeAttestation(a, await getOnchainAttestation(a.tokenId).catch(() => null)),
    ),
  );
}

/**
 * How many claimed agents one hub may pull in beyond what the upstream filter
 * returned. Each one costs a `getAgent` resolve, so the ceiling bounds what a
 * flood of claims can make a single page do; well past the claim count this
 * site plausibly carries.
 */
const CLAIMED_PER_HUB_LIMIT = 50;

/**
 * Every stored claim, read once per cache window. Claims are an enrichment: a
 * KV outage answers with an empty list (or a short one, since the index can
 * lose an id) and every listing still renders, minus the owner-provided text.
 */
async function storedClaims(): Promise<ClaimRecord[]> {
  'use cache';
  cacheLife('minutes');
  return listClaims().catch(() => []);
}

/**
 * Claims keyed by normalised token id. Normalised on both sides of the lookup
 * so a claim signed for `000297380` still meets the listing for `297380`.
 */
function claimsByTokenId(records: ClaimRecord[]): Map<string, ClaimRecord> {
  const byId = new Map<string, ClaimRecord>();
  for (const record of records) {
    if (record.fields.chainId !== CHAIN_ID) continue;
    const id = normalizeAgentId(record.fields.tokenId);
    if (id) byId.set(id, record);
  }
  return byId;
}

/**
 * Fill one listing from its owner's claim, if there is one that still holds.
 *
 * Staleness is decided against the `owner` the listing already carries, so no
 * list path gains an `ownerOf` call: a claim whose signer is no longer the
 * indexed owner is dropped rather than rendered under a new owner's name.
 */
function withClaim<T extends AgentSummary>(agent: T, claims: Map<string, ClaimRecord>): T {
  const record = claims.get(normalizeAgentId(agent.tokenId));
  if (!record || claimIsStale(record, agent.owner)) return agent;
  return applyClaim(agent, record);
}

function tokenIdSet(agents: AgentSummary[]): Set<string> {
  return new Set(agents.map((a) => normalizeAgentId(a.tokenId)));
}

/**
 * The claimed agents a hub would otherwise miss.
 *
 * An owner-provided category lives in our claim store, not in the indexed
 * metadata, so the upstream category filter cannot see it and the hub has to
 * resolve those ids itself. They join the unverified registry list: a claim
 * says who wrote the description, never that we vouch for the agent.
 */
async function claimedInCategory(
  category: Category,
  claims: Map<string, ClaimRecord>,
  already: Set<string>,
): Promise<AgentSummary[]> {
  const matches = [...claims]
    .filter(([id, record]) => record.fields.category === category && !already.has(id))
    .slice(0, CLAIMED_PER_HUB_LIMIT);
  const resolved = await Promise.all(
    matches.map(async ([id, record]) => {
      const agent = await source.getAgent(CHAIN_ID, id).catch(() => null);
      if (!agent || claimIsStale(record, agent.owner)) return null;
      return applyClaim(agent, record);
    }),
  );
  return resolved.filter((a): a is NonNullable<typeof a> => a != null);
}

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
  const enriched = await withOnchainAttestation(verified);
  const verifiedIds = new Set(enriched.map((a) => a.tokenId));
  const claims = claimsByTokenId(await storedClaims());
  const indexed = rankAndDedupe(raw.items)
    .filter((a) => !verifiedIds.has(a.tokenId))
    .map((a) => withClaim(a, claims));
  // Only a hub injects: the unfiltered directory already lists everything the
  // index knows, so there a claim can only annotate what is on the page.
  const claimed = category
    ? await claimedInCategory(category, claims, tokenIdSet([...enriched, ...indexed]))
    : [];
  const registry = [...claimed, ...indexed];
  return { verified: enriched, registry, registrySource: raw.source, asOf: new Date().toISOString() };
}

export async function listAgents(
  category?: Category,
  limit = 24,
  cursor?: string,
): Promise<Page<AgentSummary>> {
  'use cache';
  cacheLife('minutes');
  // Over-fetch so ranking/dedupe has an actual sample to work on (the registry
  // is flooded with low-signal duplicate registrations); then rank by quality
  // and collapse true duplicates before slicing to the requested page.
  const raw = await source.listAgents({ chainId: CHAIN_ID, category, limit: 100, cursor });
  const ranked = rankAndDedupe(raw.items);
  const claims = claimsByTokenId(await storedClaims());

  // Past the first page a claim only annotates: injecting there would repeat on
  // every page the visitor walks through.
  if (cursor) {
    return { ...raw, items: ranked.slice(0, limit).map((a) => withClaim(a, claims)) };
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
  const pinnedEnriched = await withOnchainAttestation(pinned);
  const pinnedIds = new Set(pinnedEnriched.map((a) => a.tokenId));
  const indexed = ranked
    .filter((a) => !pinnedIds.has(a.tokenId))
    .map((a) => withClaim(a, claims));
  const claimed = category
    ? await claimedInCategory(category, claims, tokenIdSet([...pinnedEnriched, ...indexed]))
    : [];
  // Ahead of the indexed tail so a hub's own claimed agents survive the slice;
  // still behind the pinned ones, which are the only verified cards here.
  const items = [...pinnedEnriched, ...claimed, ...indexed].slice(0, limit);
  return { ...raw, items };
}

export async function getAgent(tokenId: string): Promise<AgentDetail | null> {
  'use cache';
  cacheLife('minutes');
  const agent = await source.getAgent(CHAIN_ID, tokenId);
  if (!agent) return null;
  // The detail page used to read this itself, uncached, on every request. It
  // belongs here instead: one merged record, so a profile and a hub card cannot
  // disagree about the same agent (the same reason the attestation merge sits
  // on every path). The owner it compares against is the one just fetched, so
  // this costs a KV read and no chain read.
  const claim = await getClaim(CHAIN_ID, agent.tokenId, {
    currentOwner: agent.owner,
  }).catch(() => null);
  return applyClaim(agent, claim);
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
