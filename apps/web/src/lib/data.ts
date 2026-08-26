import 'server-only';

import { createHash } from 'node:crypto';

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
 * Claimed-only records prepended to an API window. This uses the directory's
 * fixed default page policy, never the caller's page size: a local cursor may
 * be resumed with a different `limit`, and every slice must rebuild exactly
 * the same identities and fingerprint. Keeping the fixed budget at one third
 * of the normal 24-card page also prevents claims from taking over that page.
 */
const CLAIMED_PER_API_WINDOW = Math.min(
  CLAIMED_PER_HUB_LIMIT,
  claimedHubSlots(DIRECTORY_PAGE_SIZE),
);

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
 * A claim only names candidates. `already` suppresses identities actually seen
 * in the active listing window; native metadata alone does not. After a detail
 * resolve, `claimForCategory` accepts only records whose displayed category
 * matches this hub. More ids are resolved than a page can hold (up to the read
 * cap), so dropped candidates leave the slots behind them fillable.
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
 * The deterministic claimed injection attached to the first API window.
 *
 * Resolve membership against what the active list source actually returned in
 * its first category window. A native category from `getAgent` is not enough
 * to suppress an agent: the live list can lag that detail, or the merged source
 * can currently be serving a committed snapshot. Every continuation rebuilds
 * this same cached set so an injected identity can be removed if a later
 * upstream window does contain it.
 */
async function claimedApiWindow(category: Category): Promise<AgentSummary[]> {
  'use cache';
  cacheLife('minutes');
  const [raw, records] = await Promise.all([
    readRegistryWindow(category),
    storedClaims(),
  ]);
  const claims = claimsByTokenId(records);
  return claimedInCategory(
    category,
    claims,
    // Presence is about every source identity, not the representative that
    // ranking keeps for a duplicate cluster. Otherwise a claimed token hidden
    // behind its representative is falsely treated as source-missing.
    tokenIdSet(raw.items),
    CLAIMED_PER_API_WINDOW,
  );
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
        new Set([...tokenIdSet(raw.items), ...tokenIdSet(enriched)]),
        claimedHubSlots(DIRECTORY_PAGE_SIZE),
      )
    : [];
  // Claimed entries lead the unverified list so the page's slice reaches them,
  // bounded to a share of that page so the ranked registrations keep most of it.
  const registry = await withLiveness([...claimed, ...indexed]);
  return { verified: enriched, registry, registrySource: raw.source, asOf: new Date().toISOString() };
}

/**
 * One immutable upstream window. Local `w:` cursors intentionally do not form
 * part of this cache key: every slice of the window must see the same records
 * and ranking even if registrations arrive while a caller pages through it.
 */
async function readRegistryWindow(
  category?: Category,
  upstreamCursor?: string,
): Promise<Page<AgentSummary>> {
  'use cache';
  cacheLife('minutes');
  return source.listAgents({
    chainId: CHAIN_ID,
    category,
    limit: INDEX_WINDOW_SIZE,
    cursor: upstreamCursor,
  });
}

export async function listAgents(
  category?: Category,
  limit = 24,
  cursor?: string,
): Promise<Page<AgentSummary>> {
  return listAgentWindow(category, limit, cursor, true);
}

/**
 * Page one upstream window. The public API asks for claimed-only category
 * entries; the directory walk already resolves those itself with its own page
 * budget, so it opts out to avoid resolving and paging the same injection
 * twice.
 */
async function listAgentWindow(
  category: Category | undefined,
  limit: number,
  cursor: string | undefined,
  includeClaimedCategory: boolean,
): Promise<Page<AgentSummary>> {
  const position = decodeRegistryWindowCursor(cursor);
  // The public 8004scan API always reads 100 upstream registrations at a time.
  // Read that complete window here too, then encode any remaining local offset
  // into our cursor. Advancing raw.nextCursor before the ranked tail is served
  // would permanently skip that tail for callers asking for fewer than 100.
  const raw = await readRegistryWindow(category, position.upstreamCursor);
  const claims = claimsByTokenId(await storedClaims());
  const ranked = rankAndDedupe(raw.items).map((a) => withClaim(a, claims));
  // Resolve the fixed first-window injection on every continuation. It is
  // prepended only to that first window; later windows remove the same ids if
  // the active listing source eventually reaches one, so an index-lagged or
  // snapshot-only native category is preserved without producing two cards.
  // The injection count is independent of `limit`, keeping local fingerprints
  // stable when a continuation changes its page size.
  const claimed =
    includeClaimedCategory && category
      ? await claimedApiWindow(category)
      : [];
  const listing =
    position.upstreamCursor === undefined
      ? mergeRegistryWindow(ranked, claimed)
      : excludeInjectedRegistryEntries(ranked, claimed);
  const windowId = registryWindowId(listing);
  const page = pageRegistryWindow(listing, limit, cursor, raw.nextCursor, windowId);
  return { ...raw, nextCursor: page.nextCursor, items: await withLiveness(page.items) };
}

const REGISTRY_WINDOW_CURSOR = /^w:(0|\d{1,9}):(\d{1,3}):([a-f0-9]{16})$/;

/** A local cursor no longer describes the upstream window it was issued for. */
export class RegistryCursorExpiredError extends Error {
  constructor() {
    super('registry cursor expired; restart from the first page');
    this.name = 'RegistryCursorExpiredError';
  }
}

/** A local offset cannot have been issued for the window it names. */
export class RegistryCursorInvalidError extends Error {
  constructor() {
    super('invalid registry cursor');
    this.name = 'RegistryCursorInvalidError';
  }
}

/**
 * A raw read has at most 100 entries and the API may prepend its fixed claimed
 * window. Every emitted local offset is strictly below this bound (and is
 * checked against the actual window later).
 */
const MAX_REGISTRY_WINDOW_ITEMS =
  INDEX_WINDOW_SIZE + CLAIMED_PER_API_WINDOW;

/** Whether a public listing cursor is one this module can decode safely. */
export function validRegistryCursor(cursor: string): boolean {
  if (/^\d{1,9}$/.test(cursor)) return true;
  const match = REGISTRY_WINDOW_CURSOR.exec(cursor);
  if (!match) return false;
  const offset = Number(match[2]);
  return offset > 0 && offset < MAX_REGISTRY_WINDOW_ITEMS;
}

function decodeRegistryWindowCursor(cursor?: string): {
  upstreamCursor?: string;
  offset: number;
  windowId?: string;
} {
  if (!cursor || !cursor.startsWith('w:')) return { upstreamCursor: cursor, offset: 0 };
  const match = REGISTRY_WINDOW_CURSOR.exec(cursor);
  if (!match) return { upstreamCursor: cursor, offset: 0 };
  return {
    upstreamCursor: match[1] === '0' ? undefined : match[1],
    offset: Number(match[2]),
    windowId: match[3],
  };
}

function encodeRegistryWindowCursor(
  upstreamCursor: string | undefined,
  offset: number,
  windowId: string,
): string {
  return `w:${upstreamCursor ?? '0'}:${offset}:${windowId}`;
}

/** Bind a cursor to the exact ranked identities and order it is slicing. */
function registryWindowId(items: readonly AgentSummary[]): string {
  const identities = items
    .map((agent) => `${normalizeAgentId(agent.tokenId)}:${agent.duplicateCount ?? 1}`)
    .join('|');
  return createHash('sha256').update(identities).digest('hex').slice(0, 16);
}

/**
 * Cut one local page without advancing past the unread tail of a raw window.
 * If a platform cache loses that window, its fingerprint changes and paging
 * fails explicitly instead of silently duplicating or omitting registrations.
 */
export function pageRegistryWindow<T>(
  items: readonly T[],
  limit: number,
  cursor: string | undefined,
  nextUpstreamCursor: string | null,
  windowId: string,
): { items: T[]; nextCursor: string | null } {
  const position = decodeRegistryWindowCursor(cursor);
  if (position.windowId && position.windowId !== windowId) {
    throw new RegistryCursorExpiredError();
  }
  if (position.windowId && (position.offset <= 0 || position.offset >= items.length)) {
    throw new RegistryCursorInvalidError();
  }
  return {
    items: items.slice(position.offset, position.offset + limit),
    nextCursor:
      items.length > position.offset + limit
        ? encodeRegistryWindowCursor(position.upstreamCursor, position.offset + limit, windowId)
        : nextUpstreamCursor,
  };
}

function registryOwner(agent: AgentSummary): string {
  return agent.owner.trim().toLowerCase();
}

function registryOwnedName(agent: AgentSummary): string {
  return JSON.stringify([agent.name.trim().toLowerCase(), registryOwner(agent)]);
}

/**
 * Prepend locally resolved cards without letting a stale injected owner replace
 * a fresher occurrence of the same token in the active source window.
 */
export function mergeRegistryWindow(
  raw: readonly AgentSummary[],
  injected: readonly AgentSummary[],
): AgentSummary[] {
  const rawOwners = new Map(
    raw.map((a) => [normalizeAgentId(a.tokenId), registryOwner(a)]),
  );
  const accepted = injected.filter((a) => {
    const rawOwner = rawOwners.get(normalizeAgentId(a.tokenId));
    return rawOwner === undefined || rawOwner === registryOwner(a);
  });
  const injectedIdentities = new Set(
    accepted.map((a) => `${normalizeAgentId(a.tokenId)}:${registryOwner(a)}`),
  );
  return [
    ...accepted,
    ...raw.filter(
      (a) =>
        !injectedIdentities.has(
          `${normalizeAgentId(a.tokenId)}:${registryOwner(a)}`,
        ),
    ),
  ];
}

/**
 * Remove a later occurrence only while it still has the injected owner.
 * A changed owner is fresher transfer evidence and must replace the stale
 * owner-provided view rather than being discarded by token id alone.
 */
export function excludeInjectedRegistryEntries(
  raw: readonly AgentSummary[],
  injected: readonly AgentSummary[],
): AgentSummary[] {
  const injectedIdentities = new Set(
    injected.map((a) => `${normalizeAgentId(a.tokenId)}:${registryOwner(a)}`),
  );
  const injectedOwnedNames = new Set(injected.map(registryOwnedName));
  return raw.filter(
    (a) =>
      !injectedIdentities.has(
        `${normalizeAgentId(a.tokenId)}:${registryOwner(a)}`,
      ) && !injectedOwnedNames.has(registryOwnedName(a)),
  );
}

/**
 * Replace an earlier injection in place when a raw later source window proves
 * that token has a different owner. Keeping the slot preserves every page
 * offset already issued; replacing its contents removes the stale claim. The
 * later representative is then removed by `excludeInjectedRegistryEntries`.
 */
export function reconcileInjectedRegistryEntries(
  injected: readonly AgentSummary[],
  laterRaw: readonly AgentSummary[],
  laterRanked: readonly AgentSummary[] = laterRaw,
): AgentSummary[] {
  const laterByTokenId = new Map(
    laterRaw.map((a) => [normalizeAgentId(a.tokenId), a]),
  );
  return injected.map((a) => {
    const found = laterByTokenId.get(normalizeAgentId(a.tokenId));
    if (!found || registryOwner(found) === registryOwner(a)) return a;
    // Ranking may collapse the transferred token into another registration
    // with the same name and new owner. Put that chosen representative in the
    // stable injection slot while using the raw token as ownership evidence.
    return laterRanked.find((candidate) =>
      registryOwnedName(candidate) === registryOwnedName(found)
    ) ?? found;
  });
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
 * Our own agents are dropped here because the directory renders them in its
 * verified section instead.
 */
export async function listRegistryPage(
  category?: Category,
  cursor?: string,
): Promise<RegistryPage> {
  const pageIndex = directoryPageIndex(cursor);
  const sourceReads: AgentSummary[][] = [];
  let at: string | undefined;
  let listingSource = 'unknown';
  let indexExhausted = false;
  let page = directoryPage(sourceReads, pageIndex);
  const claims = category ? claimsByTokenId(await storedClaims()) : null;
  let injected: AgentSummary[] = [];

  for (let read = 0; read < MAX_INDEX_READS; read++) {
    // listAgentWindow returns ranked representatives. Keep every raw window
    // alongside it so a claimed token collapsed into another card still counts
    // as first-window presence or later transfer evidence.
    const rawWindow =
      category && claims
        ? await readRegistryWindow(category, at)
        : null;
    const batch = await listAgentWindow(category, INDEX_WINDOW_SIZE, at, false);
    listingSource = batch.source;
    const indexed = batch.items.filter(
      (a) => !PINNED_ID_SET.has(normalizeAgentId(a.tokenId)),
    );
    // Resolve records absent from the active first category window only once,
    // then prepend them in addition to that complete window. A later window
    // may catch up to a native-category record the detail endpoint resolved
    // earlier; filtering the same-owner identity below keeps that card
    // singular, while a changed owner remains as fresher transfer evidence.
    if (read === 0 && category && claims && rawWindow) {
      injected = await withLiveness(
        await claimedInCategory(
          category,
          claims,
          new Set([...PINNED_ID_SET, ...tokenIdSet(rawWindow.items)]),
          claimedHubSlots(DIRECTORY_PAGE_SIZE),
        ),
      );
    }
    if (read > 0 && rawWindow && claims) {
      const rawWithClaims = rawWindow.items.map((a) => withClaim(a, claims));
      injected = await withLiveness(
        reconcileInjectedRegistryEntries(injected, rawWithClaims, indexed),
      );
    }
    sourceReads.push(indexed);
    // Rebuild from the reconciled set. If this window revealed a transfer, the
    // first-window slot now carries the fresh source record. Its cardinality
    // and every previously issued page offset stay fixed, while the matching
    // later representative is suppressed so the card remains singular.
    const reads = sourceReads.map((items, index) =>
      index === 0
        ? mergeRegistryWindow(items, injected)
        : excludeInjectedRegistryEntries(items, injected),
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

/** Rank, merge owner claims, then filter on the category visitors will see. */
export function rankClaimedSearchResults(
  items: readonly AgentSummary[],
  records: readonly ClaimRecord[],
  category?: Category,
): AgentSummary[] {
  const claims = claimsByTokenId([...records]);
  return rankAndDedupe([...items])
    .filter((a) => !PINNED_ID_SET.has(normalizeAgentId(a.tokenId)))
    .map((a) => withClaim(a, claims))
    .filter((a) => (category ? a.category === category : true));
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
    const ranked = rankClaimedSearchResults(
      found.items,
      await storedClaims(),
      filters.category,
    );
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
