'use client';

import { CATEGORIES, type Category } from '@agripinaa/agent-index/types';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CATEGORY_INFO } from '@/lib/categories';
import {
  MAX_QUERY_CHARS,
  directoryHref,
  hasActiveFilters,
  normalizeQuery,
  type DirectoryQuery,
} from '@/lib/directory-query';

/**
 * The directory's controls. Every one of them writes the url and nothing else:
 * the page is a server component that reads those parameters back, so a
 * filtered or searched directory is one address a visitor can share and a
 * crawler can follow, and the results are rendered on the server.
 *
 * `replace` rather than `push`, so a session of narrowing a search does not
 * bury the page the visitor arrived from under twenty history entries. Paging
 * is the exception: "Load more" is a real link on the page itself.
 */

/** How long the box waits after a keystroke before the url is written. */
const SEARCH_DEBOUNCE_MS = 300;

const controlCls =
  'rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none';

export function AgentFilters({ query }: { query: DirectoryQuery }) {
  const router = useRouter();
  const { query: applied, category, live, claimed } = query;
  const [term, setTerm] = useState(applied);

  /**
   * Where the url is being taken, which is not what the props say yet: a
   * `router.replace` lands a render or more later. The debounce compares
   * against this rather than against the props, and every control cancels a
   * pending one, so a timer armed before a click cannot fire afterwards and put
   * back the filters that click just changed.
   *
   * Never carries a cursor: a cursor only means something for the listing it
   * was issued against, so changing any filter lands back on the first page.
   */
  const target = useRef<DirectoryQuery>({ query: applied, category, live, claimed });
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The url the last navigation asked for, until that url arrives in props. */
  const asked = useRef<string | null>(null);

  // Whatever the url says becomes the new base, including a move these controls
  // did not make (the back button, or a "Load more" link). While a navigation
  // is in flight, only the url it asked for counts: the one before it is on its
  // way out, and taking that as the base would undo the move that replaced it.
  useEffect(() => {
    const fromUrl: DirectoryQuery = { query: applied, category, live, claimed };
    if (asked.current !== null && asked.current !== directoryHref(fromUrl)) return;
    target.current = fromUrl;
    asked.current = null;
  }, [applied, category, live, claimed]);

  const navigate = useCallback(
    (next: DirectoryQuery) => {
      if (pending.current !== null) {
        clearTimeout(pending.current);
        pending.current = null;
      }
      target.current = next;
      const href = directoryHref(next);
      asked.current = href;
      router.replace(href, { scroll: false });
    },
    [router],
  );

  useEffect(() => {
    const next = normalizeQuery(term);
    if (next === target.current.query) return;
    // One navigation per pause in the typing, rather than one per keystroke.
    const timer = setTimeout(
      () => navigate({ ...target.current, query: next }),
      SEARCH_DEBOUNCE_MS,
    );
    pending.current = timer;
    return () => {
      clearTimeout(timer);
      if (pending.current === timer) pending.current = null;
    };
  }, [term, applied, category, live, claimed, navigate]);

  /** What the controls render from: the url, with the box's term on it. */
  const current: DirectoryQuery = {
    query: normalizeQuery(term),
    category,
    live,
    claimed,
  };

  /**
   * What a control navigates from: where the url is headed rather than where the
   * props say it is. Two clicks inside one `router.replace` then compose, rather
   * than the second one carrying the filters the first one just changed.
   */
  const go = (patch: Partial<DirectoryQuery>) =>
    navigate({ ...target.current, query: normalizeQuery(term), ...patch });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 sm:flex-row sm:items-center">
      <label className="flex-1">
        <span className="sr-only">Search agents</span>
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          maxLength={MAX_QUERY_CHARS}
          placeholder="Search by name or description"
          className={`${controlCls} w-full`}
        />
      </label>

      <label>
        <span className="sr-only">Category</span>
        <select
          value={category ?? ''}
          onChange={(e) =>
            go({ category: (e.target.value || undefined) as Category | undefined })
          }
          className={`${controlCls} w-full sm:w-auto`}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_INFO[c].label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2">
        {/* Flipped against the url being navigated to, so a second click inside
            the first one's replace toggles it off rather than repeating it. */}
        <Toggle
          label="Live endpoint"
          pressed={live}
          onClick={() => go({ live: !target.current.live })}
        />
        <Toggle
          label="Claimed"
          pressed={claimed}
          onClick={() => go({ claimed: !target.current.claimed })}
        />
        {hasActiveFilters(current) && (
          <button
            type="button"
            onClick={() => {
              setTerm('');
              navigate({ query: '', category: undefined, live: false, claimed: false });
            }}
            className="px-2 py-1 text-xs text-muted-2 underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
        pressed
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border-strong bg-surface-2 text-muted hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}
