'use client';

import { CATEGORIES, type Category } from '@agripinaa/agent-index/types';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

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
   * The state every control navigates from. It carries no cursor, so changing
   * any filter lands back on the first page: a cursor only means anything for
   * the listing it was issued against. It reads the term from the box rather
   * than from the url, so a filter clicked mid-search keeps what the visitor
   * can see in front of them.
   */
  const current: DirectoryQuery = {
    query: normalizeQuery(term),
    category,
    live,
    claimed,
  };

  useEffect(() => {
    const next = normalizeQuery(term);
    if (next === applied) return;
    // One navigation per pause in the typing, rather than one per keystroke.
    const timer = setTimeout(() => {
      router.replace(directoryHref({ query: next, category, live, claimed }), {
        scroll: false,
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, applied, category, live, claimed, router]);

  const go = (patch: Partial<DirectoryQuery>) => {
    router.replace(directoryHref(current, patch), { scroll: false });
  };

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
        <Toggle
          label="Live endpoint"
          pressed={live}
          onClick={() => go({ live: !live })}
        />
        <Toggle
          label="Claimed"
          pressed={claimed}
          onClick={() => go({ claimed: !claimed })}
        />
        {hasActiveFilters(query) && (
          <button
            type="button"
            onClick={() => {
              setTerm('');
              router.replace(directoryHref({ query: '', live: false, claimed: false }), {
                scroll: false,
              });
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
