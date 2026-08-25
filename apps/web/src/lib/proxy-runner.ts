import 'server-only';

import { OversizedBodyError, safeFetchBytes, type SafeFetchOptions } from '@agripinaa/shared/ssrf';

import { agentsUrl } from './agents-endpoint';

/**
 * Which of the two ways a call to the agent runner failed.
 *
 * Every caller that talks to the runner splits failures the same way, and they
 * have to keep agreeing: an oversized body is the runner answering with
 * something a status or a key cannot be, and everything else (a refused
 * redirect, a timeout, a tunnel that is down) is no answer at all. One
 * definition, so a third caller cannot quietly invent a third rule.
 */
export function runnerFailure(err: unknown): 'oversized' | 'unreachable' {
  return err instanceof OversizedBodyError ? 'oversized' : 'unreachable';
}

/**
 * Ask the agent runner for `path` and hand its answer to the browser unread:
 * same status, same bytes. This exists so the browser never needs the tunnel
 * URL and never meets its CORS policy (it sets none).
 *
 * The tunnel is an untrusted boundary, so the call goes through the shared SSRF
 * guard: the base is validated, a redirect is refused rather than followed, and
 * the body is capped while it streams. The echoed bytes are declared JSON and
 * marked `nosniff`, because they are passed on unparsed: without it a browser
 * is free to sniff a type out of whatever the tunnel returned and render it.
 *
 * Callers must have established that `path` is one they meant to build before
 * this point. Nothing here validates it.
 */
export async function proxyToRunner(path: string, opts: SafeFetchOptions): Promise<Response> {
  try {
    const upstream = await safeFetchBytes(await agentsUrl(path), opts);
    return new Response(upstream.bytes, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
    });
  } catch (err) {
    const error =
      runnerFailure(err) === 'oversized' ? 'oversized upstream response' : 'agent runner unreachable';
    return Response.json({ error }, { status: 502 });
  }
}
