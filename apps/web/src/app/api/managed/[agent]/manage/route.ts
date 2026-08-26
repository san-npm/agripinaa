import { agentBySlug } from '@agripinaa/shared/agents';

import { proxyToRunner } from '@/lib/proxy-runner';
import { readLimitedRequestText, RequestBodyTooLargeError } from '@/lib/request-body';

/** Caps both directions: a serialized session in, a short status from the runner out. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Proxy a managed-account registration to the agent runner. The body is the
 * byte-exact serialized {account, chainId, session} (session-kit codec, so
 * bigint spend limits survive). We forward it verbatim; the runner does the
 * full validation (the session exists on-chain, granted to its key, router-scoped).
 *
 * The agent comes out of the URL path, so it is checked against the registry
 * before anything else happens: resolving the runner base may spend a KV
 * command, and a slug nobody registered has no endpoint to be forwarded to.
 * `agentBySlug` reads own keys only, so `constructor` and `__proto__` are not
 * agents. The refusal stays the 400 this route has always given; only the set
 * of slugs it covers grew. The proxy itself is `lib/proxy-runner.ts`, shared
 * with the manager-key route and the x402 status function, which is what keeps
 * the three of them answering a dead tunnel the same way.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ agent: string }> },
): Promise<Response> {
  const { agent } = await ctx.params;
  if (!agentBySlug(agent)) {
    return Response.json({ error: 'invalid agent' }, { status: 400 });
  }
  let body: string;
  try {
    body = await readLimitedRequestText(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'body too large' }, { status: 413 });
    }
    return Response.json({ error: 'body must be valid UTF-8' }, { status: 400 });
  }
  return proxyToRunner(`/${agent}/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    timeoutMs: 15_000,
    maxBytes: MAX_BODY_BYTES,
  });
}
