import { CATEGORIES, type AgentSummary, type Category } from '@agripinaa/agent-index/types';

/**
 * What a `/agents` url means.
 *
 * Isomorphic on purpose (no `server-only`, no data access): the page parses the
 * url on the server and the filter controls write it from the browser, so both
 * halves have to agree on the parameter names and on what counts as a value.
 * Every filter lives in the url rather than in component state, which is what
 * makes a filtered directory shareable, crawlable, and server rendered.
 */

/** Url parameter names, in one place so the page and the controls cannot drift. */
export const PARAM = {
  query: 'q',
  category: 'c',
  live: 'live',
  claimed: 'claimed',
  cursor: 'cursor',
} as const;

/**
 * Longest search term we carry. The term reaches a `use cache` entry as part of
 * its key, so an uncapped one lets a visitor mint cache entries by the
 * kilobyte; 80 characters is well past any name in the registry.
 */
export const MAX_QUERY_CHARS = 80;

export interface DirectoryQuery {
  /** Trimmed, capped, lower-cased. Empty means no search. */
  query: string;
  category?: Category;
  /** Keep only agents whose claimed endpoint answered inside the probe window. */
  live: boolean;
  /** Keep only agents whose on-chain owner has signed a claim. */
  claimed: boolean;
  /** Opaque numeric page offset. Absent means the first page. */
  cursor?: string;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * `?q=a&q=b` arrives as an array. Take the first value rather than joining
 * them, so a repeated parameter cannot carry a term past the cap.
 */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The one normalisation of a search term, applied on both sides of the url. */
export function normalizeQuery(value: string | string[] | undefined): string {
  return (first(value) ?? '').trim().slice(0, MAX_QUERY_CHARS).toLowerCase();
}

/**
 * A cursor is an opaque numeric offset (or page number) upstream. Anything else
 * is dropped, the same rule `/api/index/agents` applies, so a hand-written url
 * cannot reach the indexer as a "NaN" offset or mint unbounded cache entries.
 */
export function parseCursor(value: string | string[] | undefined): string | undefined {
  const raw = first(value);
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? raw : undefined;
}

export function parseDirectoryQuery(params: RawSearchParams): DirectoryQuery {
  const rawCategory = first(params[PARAM.category]);
  return {
    query: normalizeQuery(params[PARAM.query]),
    category: CATEGORIES.find((c) => c === rawCategory),
    live: first(params[PARAM.live]) === '1',
    claimed: first(params[PARAM.claimed]) === '1',
    cursor: parseCursor(params[PARAM.cursor]),
  };
}

/**
 * The url for a directory state, optionally with one filter changed. A patch
 * key set to `undefined` clears that filter, which is how a control drops the
 * cursor: changing a filter has to land the visitor back on the first page,
 * since a cursor is only meaningful for the listing it was issued against.
 */
export function directoryHref(
  current: DirectoryQuery,
  patch: Partial<DirectoryQuery> = {},
  pathname = '/agents',
): string {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.query) params.set(PARAM.query, next.query);
  if (next.category) params.set(PARAM.category, next.category);
  if (next.live) params.set(PARAM.live, '1');
  if (next.claimed) params.set(PARAM.claimed, '1');
  if (next.cursor) params.set(PARAM.cursor, next.cursor);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

/** True when any filter is set, so a control can offer to clear them. */
export function hasActiveFilters(query: DirectoryQuery): boolean {
  return query.query !== '' || query.category != null || query.live || query.claimed;
}

/**
 * The two filters the index cannot answer upstream.
 *
 * Liveness comes from our own stored probe results and a claim comes from our
 * own store, so neither is a field 8004scan can filter on. They are applied
 * here, after the listing has been annotated, which means they narrow the pages
 * the visitor has loaded rather than the whole registry. The empty state says
 * so rather than implying the registry holds nothing else.
 */
export function applyLocalFilters<T extends AgentSummary>(
  agents: T[],
  filters: Pick<DirectoryQuery, 'live' | 'claimed'>,
): T[] {
  if (!filters.live && !filters.claimed) return agents;
  return agents.filter(
    (a) =>
      (!filters.live || a.endpointLive === true) &&
      (!filters.claimed || a.claimed === true),
  );
}
