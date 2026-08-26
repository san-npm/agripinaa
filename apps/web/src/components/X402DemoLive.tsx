import { AGENTS, type AgentSlug } from '@agripinaa/shared/agents';
import { io } from 'next/cache';

import { runnerUrl } from '@/lib/runner-url';

import { X402Demo } from './X402Demo';

/**
 * Server half of the x402 panel: the one place the endpoint is resolved, from
 * runnerUrl() and nothing else, so the browser is handed a URL rather than a
 * rule for building one.
 *
 * runnerBase() is deterministic with no KV configured, so without io() a
 * prerender would capture the committed default into the static shell and a
 * rotated tunnel would need a redeploy to show up (the same reason the
 * manifests route resolves against the live request). Callers keep this inside
 * a Suspense boundary for that reason.
 */
export async function X402DemoLive({ slug, tokenId }: { slug: AgentSlug; tokenId: string }) {
  await io();
  const endpoint = await runnerUrl(`/${slug}/status`);
  return (
    <X402Demo
      slug={slug}
      tokenId={tokenId}
      endpoint={endpoint}
      priceUsdt={AGENTS[slug].manifest.x402.priceUsdt}
    />
  );
}
