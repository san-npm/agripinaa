import { agentBySlug } from '@agripinaa/shared/agents';

import { proxyToRunner } from '@/lib/proxy-runner';

/** {agent, token, publicKey, address} is well under 1 KB; anything bigger is not a key. */
const MAX_UPSTREAM_BYTES = 8_192;

/**
 * Proxy the agent's public manager-key so the browser never needs the tunnel
 * URL or CORS. Returns { agent, publicKey, address }. Read-only, public.
 *
 * The agent comes out of the URL path, so it is checked against the registry
 * before anything else happens (same reasoning, and the same 400, as the manage
 * route next door). The browser then checks what comes back against the
 * registry's pinned address before it becomes a session grantee
 * (src/lib/manager-key.ts).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ agent: string }> },
): Promise<Response> {
  const { agent } = await ctx.params;
  if (!agentBySlug(agent)) {
    return Response.json({ error: 'invalid agent' }, { status: 400 });
  }
  // Forward the token selector so each token resolves to its own manager key.
  const token = new URL(request.url).searchParams.get('token');
  const suffix = token && /^[A-Za-z0-9]{1,10}$/.test(token) ? `?token=${token}` : '';
  return proxyToRunner(`/${agent}/manager-key${suffix}`, {
    timeoutMs: 5_000,
    maxBytes: MAX_UPSTREAM_BYTES,
    maxRedirects: 0,
  });
}
