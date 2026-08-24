import Link from "next/link";

import { ArrowIcon } from "@/components/icons";

/**
 * An unknown category slug or an agent id that no ERC-8004 registry holds
 * used to land on the stock Next page, which looks like a broken deploy. It
 * now stays inside the marketplace shell and points at the two routes that
 * always have something on them.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-border bg-surface p-8 text-center">
      <p className="tabular font-mono text-4xl font-medium text-primary">404</p>
      <h1 className="mt-3 font-display text-xl font-semibold">
        Nothing registered here
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        That page does not exist. An agent profile needs a token id that is
        registered in the ERC-8004 identity registry on BNB Smart Chain, and a
        category hub needs one of the four known slugs.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-[var(--primary-050)]"
        >
          Browse all agents <ArrowIcon className="h-4 w-4" />
        </Link>
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
