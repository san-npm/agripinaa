import { agentBySlug } from '@agripinaa/shared/agents';
import { OversizedBodyError, safeFetchBytes } from '@agripinaa/shared/ssrf';

import { runnerUrl } from '@/lib/runner-url';

/** A status body is a few hundred bytes of numbers plus ten fills; 64 KB is ample. */
const MAX_UPSTREAM_BYTES = 64 * 1024;

/**
 * Proxy one unpaid GET to an agent's x402 status endpoint, so the browser can
 * show the runner's own 402 challenge without the tunnel URL or CORS. The
 * upstream status and body pass through as they are: a 402 with its payment
 * requirements, or whatever else the runner answered.
 *
 * The slug is checked against the registry before anything is resolved, since
 * runnerUrl() may spend a KV command and this path is open to anyone. The
 * tunnel is an untrusted boundary, so the call goes through the shared SSRF
 * guard with redirects refused and the body capped while it streams.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  if (!agentBySlug(slug)) {
    return Response.json({ error: 'unknown agent' }, { status: 404 });
  }
  try {
    const upstream = await safeFetchBytes(await runnerUrl(`/${slug}/status`), {
      timeoutMs: 5_000,
      maxBytes: MAX_UPSTREAM_BYTES,
      maxRedirects: 0,
      headers: { accept: 'application/json' },
    });
    return new Response(upstream.bytes, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof OversizedBodyError) {
      return Response.json({ error: 'oversized upstream response' }, { status: 502 });
    }
    return Response.json({ error: 'agent runner unreachable' }, { status: 502 });
  }
}
