import { agentsUrl } from '@/lib/agents-endpoint';

/**
 * Proxy a managed-account registration to the agent runner. The body is the
 * byte-exact serialized {account, chainId, session} (session-kit codec, so
 * bigint spend limits survive). We forward it verbatim; the runner does the
 * real validation (session is real on-chain, granted to its key, router-scoped).
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ agent: string }> },
): Promise<Response> {
  const { agent } = await ctx.params;
  if (!/^[a-z-]+$/.test(agent)) {
    return Response.json({ error: 'invalid agent' }, { status: 400 });
  }
  const body = await request.text();
  if (body.length > 64 * 1024) {
    return Response.json({ error: 'body too large' }, { status: 413 });
  }
  try {
    const upstream = await fetch(agentsUrl(`/${agent}/manage`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return Response.json({ error: 'agent runner unreachable' }, { status: 502 });
  }
}
