import { io } from "next/cache";

import { getProofFeed } from "@/lib/proof";

import { ProofFeed } from "./ProofFeed";

/**
 * Server half of the proof feed. getProofFeed already merges the runner events
 * with the Ophis settlement backfill, so awaiting it here puts real rows in the
 * response body instead of shipping an empty list and waiting for the browser's
 * first poll.
 *
 * Its cacheLife is short (15s stale, 60s expire), which puts it outside the
 * static shell, so every call site has to keep this inside a Suspense boundary.
 * Passing the plain <ProofFeed /> as that boundary's fallback keeps the
 * pre-existing skeleton, and its polling still fills the feed if the runner is
 * slow to answer. io() states the exclusion up front, so the prerender does not
 * warm a cache entry it is then going to discard.
 */
export async function ProofFeedLive({ compact = false }: { compact?: boolean }) {
  await io();
  const initial = await getProofFeed();
  return <ProofFeed compact={compact} initial={initial} />;
}
