import { OversizedBodyError, safeFetchBytes } from '@agripinaa/shared/ssrf';

import { agentsUrl } from '@/lib/agents-endpoint';

/** {agent, token, publicKey, address} is well under 1 KB; anything bigger is not a key. */
const MAX_UPSTREAM_BYTES = 8_192;

/**
 * Proxy the agent's public manager-key so the browser never needs the tunnel
 * URL or CORS. Returns { agent, publicKey, address }. Read-only, public.
 *
 * The tunnel is an untrusted boundary, so the call goes through the shared
 * SSRF guard with redirects refused and the body capped while it streams. The
 * browser then checks what comes back against the registry's pinned address
 * before it becomes a session grantee (src/lib/manager-key.ts).
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ agent: string }> },
): Promise<Response> {
  const { agent } = await ctx.params;
  if (!/^[a-z-]+$/.test(agent)) {
    return Response.json({ error: 'invalid agent' }, { status: 400 });
  }
  // Forward the token selector so each token resolves to its own manager key.
  const token = new URL(request.url).searchParams.get('token');
  const suffix = token && /^[A-Za-z0-9]{1,10}$/.test(token) ? `?token=${token}` : '';
  try {
    const upstream = await safeFetchBytes(await agentsUrl(`/${agent}/manager-key${suffix}`), {
      timeoutMs: 5_000,
      maxBytes: MAX_UPSTREAM_BYTES,
      maxRedirects: 0,
    });
    return new Response(upstream.bytes, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof OversizedBodyError) {
      return Response.json({ error: 'oversized upstream response' }, { status: 502 });
    }
    return Response.json({ error: 'agent runner unreachable' }, { status: 502 });
  }
}
