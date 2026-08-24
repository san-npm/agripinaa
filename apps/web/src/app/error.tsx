"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Everything this marketplace renders depends on a third party: the 8004scan
 * indexer, a BSC RPC, the agent runner tunnel, or the Ophis orderbook. When
 * one of them fails in a way the data layer cannot absorb, a visitor used to
 * get the stock Next error screen. This keeps them inside the site and offers
 * the retry, since most of these failures clear on a second attempt.
 *
 * `retry` (stable in Next 16.3) re-fetches and re-renders the boundary's
 * children, which is what a transient upstream needs; `reset` would only clear
 * the error state and re-render the same stale result.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[agripinaa] render error", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg rounded-xl border border-border bg-surface p-8 text-center">
      <span className="tabular font-mono text-xs uppercase tracking-wider text-danger">
        Upstream error
      </span>
      <h1 className="mt-3 font-display text-xl font-semibold">
        This page could not be loaded
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        A source this page reads from (the ERC-8004 indexer, a BNB Smart Chain
        RPC, or an agent endpoint) did not answer. Nothing on-chain was
        affected.
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-[10px] text-muted-2">
          digest {error.digest}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-[var(--primary-050)]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
