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
 * How wide one upstream read of the registry is. `source.listAgents`
 * over-fetches this many registrations so ranking has a sample to work on, so
 * this is what one read actually brings back.
 */
const INDEX_WINDOW_SIZE = 100;

/**
 * How many upstream reads one directory request may make. This is the bound a
 * hand-written `?cursor=` runs into: whatever number it carries, one render
 * cannot fan out past this.
 *
 * Four rather than more because the reads are sequential (each cursor comes off
 * the previous response) and a listing narrowed to a category spends all of
 * them: the registry classifies into a hub so rarely that such a listing never
 * fills a page, so it never stops early. Measured against 8004scan at about
 * 1.3s per cold read, which puts the worst cold render (a category, four reads,
 * plus the verified section) near 7s and every render inside the cache window
 * at single-digit milliseconds. Ten reads cost that path 10s to add one card.
 */
const MAX_INDEX_READS = 4;

/** How many registrations one walk reads at most. */
export const DIRECTORY_WALK_DEPTH = MAX_INDEX_READS * INDEX_WINDOW_SIZE;

/**
 * How deep "Load more" reaches. Derived from the read cap rather than picked,
 * so every registration those reads bring back has a page it appears on. The
 * directory used to page a whole read at a time while rendering
 * `DIRECTORY_PAGE_SIZE` of it, which left the ranked remainder of every read
 * with no url at all; the pages now cut one ranked listing end to end.
 */
export const MAX_DIRECTORY_PAGES = Math.ceil(
  DIRECTORY_WALK_DEPTH / DIRECTORY_PAGE_SIZE,
);

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
 * The listing the walk has read so far, ranked and de-duplicated end to end.
 *
 * `rankAndDedupe` does the collapsing over everything read at once, which is
 * why the walk re-reads what sits before the cursor: it can only collapse what
 * it can see, so a name minted either side of a read boundary used to survive
 * as two cards. Its output is then grouped back by the read each card first
 * arrived in, and stays in quality order inside each group.
 *
 * That grouping is what makes a page mean the same thing however deep the
 * visitor has walked. Ranked as one flat set, a high-signal registration two
 * reads down inserts near the top and pushes every page boundary along with it,
 * so the page after it repeats cards the page before it had already shown
 * (measured: pages 3 and 4 of `/agents` shared six). Grouped, a later read
 * appends rather than inserts.
 */
function directoryListing(reads: AgentSummary[][]): AgentSummary[] {
  // A card can stand for more than one registration: rankAndDedupe keeps the
  // best of a name+owner pair and collapses clusters of low-signal
  // registrations that share a name. So a card belongs to the earliest read any
  // of the registrations behind it arrived in, not to its representative's.
  const byOwnedName = new Map<string, number>();
  const byName = new Map<string, number>();
  reads.forEach((read, index) => {
    for (const a of read) {
      const name = a.name.trim().toLowerCase();
      const owned = `${name}|${a.owner.toLowerCase()}`;
      if (!byOwnedName.has(owned)) byOwnedName.set(owned, index);
      if (!byName.has(name)) byName.set(name, index);
    }
  });
  const readOf = (a: AgentSummary): number => {
    const name = a.name.trim().toLowerCase();
    return a.duplicateCount != null
      ? (byName.get(name) ?? 0)
      : (byOwnedName.get(`${name}|${a.owner.toLowerCase()}`) ?? 0);
  };
  // Sort is stable, so quality order survives inside each read's group.
  return rankAndDedupe(reads.flat()).sort((a, b) => readOf(a) - readOf(b));
}

/**
 * One page of the directory, cut from that listing.
 *
 * Pure, and the shape that makes paging cover the registry: every card holds
 * exactly one position in one listing, so it lands on exactly one page and no
 * part of a read is stranded behind a cursor no link ever issues.
 */
export function directoryPage(
  reads: AgentSummary[][],
  pageIndex: number,
): { items: AgentSummary[]; hasMore: boolean } {
  const listing = directoryListing(reads);
  const start = pageIndex * DIRECTORY_PAGE_SIZE;
  return {
    items: listing.slice(start, start + DIRECTORY_PAGE_SIZE),
    hasMore: listing.length > start + DIRECTORY_PAGE_SIZE,
  };
}

/**
 * The page a cursor names. A cursor is an offset into this listing, so a link
 * the pager issued sits on a page boundary; one that does not (hand-written, or
 * a bookmark from when the parameter meant something else) rounds down to the
 * page holding it, and one past the walk's depth lands on the deepest page it
 * can reach. Neither is an error: a directory url that half works beats a 404.
 */
export function directoryPageIndex(cursor?: string): number {
  const at = cursor ? Number(cursor) : 0;
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.min(Math.floor(at / DIRECTORY_PAGE_SIZE), MAX_DIRECTORY_PAGES - 1);
}

export interface RegistryPage {
  items: AgentSummary[];
  /** Cursor for the next page, or null once the listing is exhausted. */
  nextCursor: string | null;
  /** Where the listing came from (8004scan, snapshot, a stale cache). */
  source: string;
  /**
   * True when the walk stops here with the listing still going: either the
   * requested page is the deepest one reachable, or the reads ran out before a
   * further page filled. A caller says where it stops instead of offering a
   * "load more" that comes back to the same place.
   */
  capped: boolean;
}

/**
 * One page of the unverified registry listing, de-duplicated against every
 * registration the walk read before it.
 *
 * The walk re-reads the index from the top on every request and cuts the
 * requested page out of the ranked union, rather than advancing the index's own
 * cursor once per page: the index hands back `INDEX_WINDOW_SIZE` registrations
 * per read while a page shows `DIRECTORY_PAGE_SIZE` of them, so following its
 * cursor per page skipped everything a read returned below the page size.
 *
 * Cost: one `listAgents` call per read, made in sequence since each cursor comes
 * off the previous response. Each call is a `use cache` entry keyed on its
 * arguments and shared with every other page of the same listing, so inside the
 * cache window a deep page costs one upstream fetch and a handful of warm reads.
 * The walk stops as soon as it has one ranked entry past the requested page, so
 * the unfiltered first page costs a single read; a listing narrowed to a
 * category never fills a page and so spends the whole `MAX_INDEX_READS` budget,
 * which is what that budget is sized against. However deep the cursor points, it
 * cannot make more reads than that.
 *
 * Our own agents are dropped here: they lead the first read of `listAgents`
 * (pinned), and a directory renders them in its verified section instead.
 */
export async function listRegistryPage(
  category?: Category,
  cursor?: string,
): Promise<RegistryPage> {
  const pageIndex = directoryPageIndex(cursor);
  const reads: AgentSummary[][] = [];
  let at: string | undefined;
  let listingSource = 'unknown';
  let indexExhausted = false;
  let page = directoryPage(reads, pageIndex);

  for (let read = 0; read < MAX_INDEX_READS; read++) {
    const batch = await listAgents(category, INDEX_WINDOW_SIZE, at);
    listingSource = batch.source;
    reads.push(
      batch.items.filter((a) => !PINNED_ID_SET.has(normalizeAgentId(a.tokenId))),
    );
    page = directoryPage(reads, pageIndex);
    if (batch.nextCursor === null) {
      indexExhausted = true;
      break;
    }
    at = batch.nextCursor;
    // One ranked entry past this page is all the pager needs to know there is
    // another, so stop rather than make a read this render will not show.
    if (page.hasMore) break;
  }

  const nextPage = pageIndex + 1;
  const nextCursor =
    page.hasMore && nextPage < MAX_DIRECTORY_PAGES
      ? String(nextPage * DIRECTORY_PAGE_SIZE)
      : null;
  // Either this is the deepest page the walk reaches with the listing still
  // going, or the reads ran out before the next page filled. Both mean the same
  // thing to a visitor: this is as far as one request goes.
  const capped = nextCursor === null && (page.hasMore || !indexExhausted);

  return { items: page.items, nextCursor, source: listingSource, capped };
}

export interface SearchResults {
  items: AgentSummary[];
  /**
   * False when the live index did not answer this search (a rate limit, an
   * upstream error, a throw). A caller then shows the ranked listing and says
   * search is unavailable, rather than rendering an empty page that reads as
   * "nothing matches" off a question nothing answered.
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
    const found = await source.searchAgentsWithSource(CHAIN_ID, term);
    // The committed snapshot answering in the index's place is a local sample,
    // not the index. Its silence is not evidence that nothing matches, so the
    // caller gets the ranked listing and the unavailable line instead of an
    // empty state it has no grounds for.
    if (found.source !== 'index') return { items: [], available: false };
    const claims = claimsByTokenId(await storedClaims());
    const ranked = rankAndDedupe(found.items)
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
