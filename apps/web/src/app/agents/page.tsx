import type { AgentSummary } from "@agripinaa/agent-index";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { AgentFilters } from "@/components/AgentFilters";
import { listFirstParty, listRegistryPage, searchDirectory } from "@/lib/data";
import {
  applyLocalFilters,
  directoryHref,
  parseDirectoryQuery,
  type DirectoryQuery,
} from "@/lib/directory-query";

export const metadata: Metadata = {
  title: "All agents · Agripinaa",
  description:
    "Every AI agent registered in the ERC-8004 identity registry on BNB Smart Chain, with Agripinaa's first-party agents kept separate.",
};

/** What one directory render has to show, whichever path produced it. */
interface Listing {
  items: AgentSummary[];
  nextCursor: string | null;
  /** Where the listing came from. Null for search results, which span sources. */
  source: string | null;
  /** True when these are search results rather than the ranked listing. */
  searched: boolean;
  /** True when the search could not run, so this is the listing instead. */
  searchUnavailable: boolean;
  /** True when the walk stops here with the listing still going. */
  capped: boolean;
}

async function loadListing(query: DirectoryQuery): Promise<Listing> {
  if (query.query !== "") {
    const found = await searchDirectory(query.query, {
      category: query.category,
    });
    if (found.available) {
      return {
        items: found.items,
        nextCursor: null,
        source: null,
        searched: true,
        searchUnavailable: false,
        capped: false,
      };
    }
  }
  // Both the plain directory and a search the index could not answer: the
  // ranked listing is what a visitor gets to see either way, never a blank page.
  const page = await listRegistryPage(query.category, query.cursor);
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    source: page.source,
    searched: false,
    searchUnavailable: query.query !== "",
    capped: page.capped,
  };
}

async function Filters({
  searchParams,
}: Pick<PageProps<"/agents">, "searchParams">) {
  return <AgentFilters query={parseDirectoryQuery(await searchParams)} />;
}

async function Directory({
  searchParams,
}: Pick<PageProps<"/agents">, "searchParams">) {
  const query = parseDirectoryQuery(await searchParams);
  const [firstParty, listing] = await Promise.all([
    listFirstParty(query.category),
    loadListing(query),
  ]);
  // Liveness and claims are ours, not fields the index can filter on upstream,
  // so these two narrow what the walk already loaded. The empty state says so.
  const shown = applyLocalFilters(listing.items, query);

  return (
    <>
      {firstParty.length > 0 && (
        <section className="mb-12">
          <h2 className="font-display text-lg font-semibold">Agripinaa agents</h2>
          <p className="mb-4 mt-1 text-sm text-muted-2">
            Eight live strategies built and run by Agripinaa, all open to public
            managed mandates. Harvester and Steward use deliberately different
            yield policies; the other six expose their own grid, protection, LP,
            and rebalancing workflows.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {firstParty.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-display text-lg font-semibold">
          {listing.searched ? "Search results" : "ERC-8004 registry"}
        </h2>
        <p className="mb-4 mt-1 text-sm text-muted-2">
          {listing.searched
            ? "Registrations on BNB Smart Chain matching this search, ranked by signal quality and de-duplicated."
            : "Every other agent registered on BNB Smart Chain, ranked by signal quality and de-duplicated."}{" "}
          These are permissionless registrations: discoverable, but their
          execution is <strong>unverified</strong>. We do not vouch for them.
        </p>

        {listing.searchUnavailable && (
          <p className="mb-4 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm text-muted">
            Search is unavailable right now. The ranked listing is below.
          </p>
        )}

        {shown.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        ) : (
          <EmptyListing query={query} listing={listing} />
        )}

        <Pager query={query} listing={listing} />

        {listing.source && (
          <p className="mt-6 text-xs text-muted-2">
            Source: {listing.source}. Same-name low-signal registrations are
            collapsed into a single card with a count.
          </p>
        )}
      </section>
    </>
  );
}

function emptyReason(query: DirectoryQuery, listing: Listing): string {
  // A local filter emptying a page that did load agents is a different message
  // from a page that came back with nothing at all.
  if ((query.live || query.claimed) && listing.items.length > 0) {
    return "No agents on the pages loaded so far match this filter.";
  }
  if (listing.searched) return `No agents match "${query.query}".`;
  // A capped walk stops short of where the registry ends, so a page past it is
  // past what one request reads, not past what the registry holds.
  if (query.cursor) {
    return listing.capped
      ? "This page sits deeper than one walk of the registry reaches."
      : "This page sits past the end of the listing.";
  }
  return "No agents in this listing yet.";
}

function EmptyListing({
  query,
  listing,
}: {
  query: DirectoryQuery;
  listing: Listing;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-surface p-8 text-center">
      <p className="text-sm text-muted">{emptyReason(query, listing)}</p>
      {(query.live || query.claimed) && (
        <p className="mt-1 text-xs text-muted-2">
          The live-endpoint and claimed filters apply to the pages loaded so
          far, not to the whole registry. Load more, or clear the filter.
        </p>
      )}
    </div>
  );
}

function Pager({
  query,
  listing,
}: {
  query: DirectoryQuery;
  listing: Listing;
}) {
  // A search answers in one shot upstream, so there is nothing to page through.
  if (listing.searched) return null;
  // `nextCursor` is already null where the walk stops, so a capped listing says
  // where it stops instead of offering a link that comes back to the same page.
  const more = listing.nextCursor;
  // Only under cards: on a page the walk never reached, the empty state has
  // already said so and this would repeat it.
  const capNote = listing.capped && listing.items.length > 0;
  if (!more && !capNote && !query.cursor) return null;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-4">
      {more && (
        <Link
          href={directoryHref(query, { cursor: more })}
          className="rounded-lg border border-border-strong bg-surface-2 px-4 py-2 text-sm font-medium transition-colors hover:border-primary hover:text-primary"
        >
          Load more
        </Link>
      )}
      {capNote && (
        <p className="text-xs text-muted-2">
          This is as far as one walk of the registry reaches. Narrowing the
          listing gets you further into it.
        </p>
      )}
      {query.cursor && (
        <Link
          href={directoryHref(query, { cursor: undefined })}
          className="text-xs text-muted-2 transition-colors hover:text-foreground"
        >
          Back to the first page
        </Link>
      )}
    </div>
  );
}

export default function AgentsPage(props: PageProps<"/agents">) {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold">All agents</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Agents that prove their execution, kept clearly apart from the
        permissionless registry we merely index.
      </p>
      {/* The filters and the listing read the url, so each sits behind its own
          boundary and the rest of the page is still part of the static shell. */}
      <div className="mt-6">
        <Suspense
          fallback={
            <div
              aria-hidden
              className="h-[62px] rounded-xl border border-border bg-surface"
            />
          }
        >
          <Filters searchParams={props.searchParams} />
        </Suspense>
      </div>
      <div className="mt-8">
        <Suspense fallback={<p className="text-muted-2">Loading agents…</p>}>
          <Directory searchParams={props.searchParams} />
        </Suspense>
      </div>
    </div>
  );
}
