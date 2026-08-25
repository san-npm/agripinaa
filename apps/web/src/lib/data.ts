import 'server-only';

import {
  MergedSource,
  isIndividuallyNotable,
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
import { applyClaim, claimForCategory, claimedHubSlots } from './claim-merge';
import {
  claimIsStale,
  getClaim,
  listClaims,
  normalizeAgentId,
  type ClaimRecord,
} from './claims';
import { normalizeQuery } from './directory-query';
import { withLiveness } from './liveness';
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
 * The same ids, normalised for comparison against an indexed listing. A path
 * that renders our agents in their own section drops them from the registry
 * listing with this, so no agent gets two cards on one page.
 */
const PINNED_ID_SET = new Set(PINNED_AGENT_IDS.map(normalizeAgentId));

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
 * How many registry cards one directory page renders, and so the page size the
 * claimed injection is budgeted against, the way a hub budgets against its own
 * limit. `/agents` walks the listing this many at a time.
 */
export const DIRECTORY_PAGE_SIZE = 24;

/**
 * How many pages one directory request may walk. `/agents` re-reads the pages
 * before its cursor so de-duplication can span them, so this is what stops a
 * hand-written `?cursor=` from fanning that walk out. Ten pages reaches 240
 * cards deep, past anything a visitor pages to by hand.
 */
const MAX_DIRECTORY_PAGES = 10;

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
 * The claimed agents a hub would otherwise miss, at most `slots` of them.
 *
 * An owner-provided category lives in our claim store, not in the indexed
 * metadata, so the upstream category filter cannot see it and the hub has to
 * resolve those ids itself. They join the unverified registry list: a claim
 * says who wrote the description, never that we vouch for the agent.
 *
 * A claim only names candidates. `claimForCategory` decides membership on the
 * merged record, so an id whose indexed metadata declares another category is
 * dropped here rather than shown on the wrong hub. More ids are resolved than
 * a page can hold (up to the read cap), so dropped candidates leave the slots
 * behind them fillable.
 */
async function claimedInCategory(
  category: Category,
  claims: Map<string, ClaimRecord>,
  already: Set<string>,
  slots: number,
): Promise<AgentSummary[]> {
  const matches = [...claims]
    .filter(([id, record]) => record.fields.category === category && !already.has(id))
    .slice(0, CLAIMED_PER_HUB_LIMIT);
  const resolved = await Promise.all(
    matches.map(async ([id, record]) => {
      const agent = await source.getAgent(CHAIN_ID, id).catch(() => null);
      if (!agent || claimIsStale(record, agent.owner)) return null;
      return claimForCategory(agent, record, category);
    }),
  );
  return resolved.filter((a): a is NonNullable<typeof a> => a != null).slice(0, slots);
}

/**
 * Our own agents: resolved from the chain and reflected against the on-chain
 * attestation. Split out of `listDirectory` so a page that walks the registry
 * itself can render the verified section without pulling a registry sample it
 * will not use.
 */
export async function listVerified(category?: Category): Promise<AgentSummary[]> {
  'use cache';
  cacheLife('minutes');
  const resolved = (
    await Promise.all(
      PINNED_AGENT_IDS.map((id) => source.getAgent(CHAIN_ID, id).catch(() => null)),
    )
  )
    .filter((a): a is NonNullable<typeof a> => a != null)
    .filter((a) => (category ? a.category === category : true));
  return withOnchainAttestation(resolved);
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
  const enriched = await listVerified(category);
  const verifiedIds = new Set(enriched.map((a) => a.tokenId));
  const claims = claimsByTokenId(await storedClaims());
  const indexed = rankAndDedupe(raw.items)
    .filter((a) => !verifiedIds.has(a.tokenId))
    .map((a) => withClaim(a, claims));
  // Only a hub injects: the unfiltered directory already lists everything the
  // index knows, so there a claim can only annotate what is on the page.
  const claimed = category
    ? await claimedInCategory(
        category,
        claims,
        tokenIdSet([...enriched, ...indexed]),
        claimedHubSlots(DIRECTORY_PAGE_SIZE),
      )
    : [];
  // Claimed entries lead the unverified list so the page's slice reaches them,
  // bounded to a share of that page so the ranked registrations keep most of it.
  const registry = await withLiveness([...claimed, ...indexed]);
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
    const page = ranked.slice(0, limit).map((a) => withClaim(a, claims));
    return { ...raw, items: await withLiveness(page) };
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
    ? await claimedInCategory(
        category,
        claims,
        tokenIdSet([...pinnedEnriched, ...indexed]),
        claimedHubSlots(limit),
      )
    : [];
  // Ahead of the indexed tail so a hub's own claimed agents survive the slice,
  // and capped at a third of the page so they cannot take it; still behind the
  // pinned ones, which are the only verified cards here.
  const items = [...pinnedEnriched, ...claimed, ...indexed].slice(0, limit);
  return { ...raw, items: await withLiveness(items) };
}

/**
 * What a rendered card stands for, so "already shown" survives a re-rank.
 *
 * `rankAndDedupe` collapses low-signal registrations that share a name across
 * owners and gives the cluster the newest registration's face, so that card's
 * id changes as more pages join the set. Keyed by id alone, the cluster would
 * read as new one page later and open a second card for the same name.
 */
function shownKey(agent: AgentSummary): string {
  return isIndividuallyNotable(agent)
    ? `id:${agent.id}`
    : `name:${agent.name.trim().toLowerCase()}`;
}

/**
 * The entries of the last walked page that the pages before it did not already
 * show, ranked and de-duplicated across the whole walk.
 *
 * Pure, and the reason a paged directory re-reads the earlier pages at all:
 * `rankAndDedupe` can only collapse what it can see, so a name minted either
 * side of a page boundary used to survive as two cards.
 */
export function freshOnLastPage(pages: AgentSummary[][]): AgentSummary[] {
  const union = rankAndDedupe(pages.flat());
  if (pages.length < 2) return union;
  const before = new Set(rankAndDedupe(pages.slice(0, -1).flat()).map(shownKey));
  return union.filter((a) => !before.has(shownKey(a)));
}

export interface RegistryPage {
  items: AgentSummary[];
  /** Cursor for the next page, or null once the listing is exhausted. */
  nextCursor: string | null;
  /** Where the listing came from (8004scan, snapshot, a stale cache). */
  source: string;
  /**
   * True when the requested page sits deeper than one request walks. The items
   * are then the deepest page this walk could reach, and a caller stops
   * offering "load more": the next cursor would walk to the same cap and hand
   * back the same cards.
   */
  capped: boolean;
}

/**
 * One page of the unverified registry listing, de-duplicated against every
 * page before it.
 *
 * Cost: one `listAgents` call per page walked. Each is a `use cache` entry
 * keyed on its arguments, so inside the cache window page n costs one upstream
 * fetch and n warm reads, and on a cold cache it costs n+1 fetches. The walk
 * stops at `MAX_DIRECTORY_PAGES`, and stops sooner once the cursors it is
 * following have passed the requested one, so a hand-written `?cursor=` cannot
 * make a single request fan out. A cursor the walk never meets lands on the
 * last page it could read rather than on an error.
 *
 * Our own agents are dropped here: they lead the first page of `listAgents`
 * (pinned), and a directory renders them in its verified section instead.
 */
export async function listRegistryPage(
  category?: Category,
  cursor?: string,
): Promise<RegistryPage> {
  const pages: AgentSummary[][] = [];
  let at: string | undefined;
  let nextCursor: string | null = null;
  let listingSource = 'unknown';
  let capped = false;
  for (let walked = 0; walked < MAX_DIRECTORY_PAGES; walked++) {
    const page = await listAgents(category, DIRECTORY_PAGE_SIZE, at);
    pages.push(
      page.items.filter((a) => !PINNED_ID_SET.has(normalizeAgentId(a.tokenId))),
    );
    nextCursor = page.nextCursor;
    listingSource = page.source;
    // Reached the requested page, or ran out of listing before it.
    if (cursor === undefined || at === cursor || page.nextCursor === null) break;
    // Cursors from the index grow monotonically (an offset, or a page number),
    // so one that has already passed the requested value will never meet it.
    if (Number(page.nextCursor) > Number(cursor)) break;
    at = page.nextCursor;
    capped = walked === MAX_DIRECTORY_PAGES - 1;
  }
  return { items: freshOnLastPage(pages), nextCursor, source: listingSource, capped };
}

export interface SearchResults {
  items: AgentSummary[];
  /**
   * False when the index could not answer at all (a rate limit, an upstream
   * error). A caller shows the listing and says search is unavailable rather
   * than rendering an empty page that reads as "nothing matches".
   */
  available: boolean;
}

/**
 * Search the index, then apply the same treatment the list paths apply: rank
 * and collapse duplicates, fill in owner claims, and mark endpoints a probe
 * found answering. Our own agents are dropped for the same reason as in
 * `listRegistryPage`, since a directory lists them in its verified section.
 *
 * The term is part of this entry's cache key, so it is normalised and capped
 * here rather than trusted from the caller.
 */
export async function searchDirectory(
  query: string,
  filters: { category?: Category } = {},
): Promise<SearchResults> {
  'use cache';
  cacheLife('minutes');
  const term = normalizeQuery(query);
  if (term === '') return { items: [], available: true };
  try {
    const found = await source.searchAgents(CHAIN_ID, term);
    const claims = claimsByTokenId(await storedClaims());
    const ranked = rankAndDedupe(found)
      .filter((a) => !PINNED_ID_SET.has(normalizeAgentId(a.tokenId)))
      .filter((a) => (filters.category ? a.category === filters.category : true))
      .map((a) => withClaim(a, claims));
    return { items: await withLiveness(ranked), available: true };
  } catch {
    return { items: [], available: false };
  }
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
