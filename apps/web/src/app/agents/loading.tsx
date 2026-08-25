/**
 * Fallback for the full directory, which is the one route that waits on a
 * hundred-agent indexer page before it can draw anything. Same card geometry
 * as the loaded grid, so the layout does not jump when content lands.
 *
 * Deliberately NOT at the app root. A root loading.tsx wraps every segment,
 * which starts the response body streaming before `notFound()` can run, and
 * that turns an unknown category from a 404 into a 200 soft 404 (measured:
 * /c/nonsense answered 200 with a root loading.tsx and 404 without it). The
 * routes that call notFound() keep their hard status this way, and the pages
 * that fetch already carry their own Suspense fallbacks.
 */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="h-8 w-64 animate-pulse rounded-lg bg-surface" />
      <div className="mt-3 h-4 w-96 max-w-full animate-pulse rounded bg-surface" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-xl border border-border bg-surface"
          />
        ))}
      </div>
    </div>
  );
}
