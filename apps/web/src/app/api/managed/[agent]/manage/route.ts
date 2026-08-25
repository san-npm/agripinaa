import { OversizedBodyError, safeFetchBytes } from '@agripinaa/shared/ssrf';

import { agentsUrl } from '@/lib/agents-endpoint';

/** Caps both directions: a serialized session in, a short status from the runner out. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Proxy a managed-account registration to the agent runner. The body is the
 * byte-exact serialized {account, chainId, session} (session-kit codec, so
 * bigint spend limits survive). We forward it verbatim; the runner does the
 * full validation (the session exists on-chain, granted to its key, router-scoped).
 *
 * The tunnel is an untrusted boundary, so the call goes through the shared
 * SSRF guard: the base is validated, a redirect is refused outright (a POST
 * never follows one), and the answer is capped while it streams.
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
  if (body.length > MAX_BODY_BYTES) {
    return Response.json({ error: 'body too large' }, { status: 413 });
  }
  try {
    const upstream = await safeFetchBytes(await agentsUrl(`/${agent}/manage`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: 15_000,
      maxBytes: MAX_BODY_BYTES,
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
