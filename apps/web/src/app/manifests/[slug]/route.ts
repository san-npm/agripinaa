import { connection } from 'next/server';

import { buildManifest, MANIFEST_SLUGS } from '@/lib/manifests';
import { runnerBase } from '@/lib/runner-url';

/**
 * Serves the agent manifests that on-chain ERC-8004 tokenURIs resolve to.
 * Those URIs are minted and permanent, so the paths (/manifests/<slug>.json)
 * and the bodies stay exactly as the static files served them; only
 * x402.endpoint is resolved per request, which is what lets a rotated tunnel
 * be picked up without a redeploy.
 */

/** Enumerates the served paths; each is still rendered per request, below. */
export function generateStaticParams() {
  return MANIFEST_SLUGS.map((slug) => ({ slug: `${slug}.json` }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  // runnerBase() is deterministic with no KV configured, so without this the
  // build would prerender all four bodies and freeze the committed default
  // endpoint into static files, which is the redeploy-to-rotate problem this
  // route exists to remove. Resolve against the live request instead.
  await connection();
  const manifest = buildManifest(slug.replace(/\.json$/, ''), await runnerBase());
  if (!manifest) return new Response('Not found', { status: 404 });
  return Response.json(manifest, {
    headers: { 'cache-control': 'public, max-age=60, s-maxage=60' },
  });
}
