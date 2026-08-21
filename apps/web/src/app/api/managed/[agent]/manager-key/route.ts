import { agentsUrl } from '@/lib/agents-endpoint';

/**
 * Proxy the agent's public manager-key so the browser never needs the tunnel
 * URL or CORS. Returns { agent, publicKey, address }. Read-only, public.
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
    const upstream = await fetch(agentsUrl(`/${agent}/manager-key${suffix}`), {
      signal: AbortSignal.timeout(5_000),
    });
    // Treat the tunnel as untrusted: bound the response before parsing.
    const text = await upstream.text();
    if (text.length > 8_192) {
      return Response.json({ error: 'oversized upstream response' }, { status: 502 });
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return Response.json({ error: 'agent runner unreachable' }, { status: 502 });
  }
}
