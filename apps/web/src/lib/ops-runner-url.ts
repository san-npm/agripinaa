import 'server-only';

import { assertResolvedHostPublic, type LookupFn } from '@agripinaa/shared/ssrf';

import { bearerMatches } from './bearer';
import { isSafeRunnerUrl } from './runner-url';

/**
 * A self-report carries one URL capped at 300 chars, so anything past a few KB
 * is not a report. Cap before parsing: this route is reachable by anyone.
 */
const MAX_BODY_BYTES = 4_096;

export type RunnerUrlReport =
  | { ok: true; url: string }
  | { ok: false; status: 400 | 401 | 503; message: string };

/**
 * Everything POST /api/ops/runner-url decides before it writes, kept separate
 * from the route so each rejection is directly testable (the route itself only
 * unwraps the request and performs the KV write).
 *
 * Order matters. An unset OPS_TOKEN closes the endpoint rather than opening it,
 * authentication runs before the body is read, and the host is checked twice:
 * `isSafeRunnerUrl` on the literal, then `assertResolvedHostPublic` on what the
 * name actually resolves to. The second check exists because the first is
 * synchronous by design (it runs on every read) and so cannot resolve DNS,
 * which leaves a public-looking hostname pointing at 169.254.169.254 or
 * RFC1918. This write path is where a candidate first enters the system and is
 * already async, so it is the place to close that. `lookup` is injectable only
 * so tests can exercise it without live DNS.
 */
export async function decideRunnerUrlReport(input: {
  opsToken: string | undefined;
  authorization: string | null;
  readBodyText: () => Promise<string>;
  lookup?: LookupFn;
}): Promise<RunnerUrlReport> {
  const token = input.opsToken?.trim();
  if (!token) return { ok: false, status: 503, message: 'ops token not configured' };
  if (!bearerMatches(input.authorization, token)) {
    return { ok: false, status: 401, message: 'unauthorized' };
  }

  let raw: string;
  try {
    raw = await input.readBodyText();
  } catch {
    return { ok: false, status: 400, message: 'unreadable body' };
  }
  if (raw.length > MAX_BODY_BYTES) return { ok: false, status: 400, message: 'body too large' };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: 'bad json' };
  }

  const url = (body as { url?: unknown } | null)?.url;
  if (!isSafeRunnerUrl(url)) return { ok: false, status: 400, message: 'bad url' };

  try {
    await assertResolvedHostPublic(new URL(url), input.lookup);
  } catch {
    // One message for both outcomes the guard rejects: an address in a private
    // range, and a name that does not resolve at all. Neither is reportable,
    // and distinguishing them would turn the route into a DNS oracle.
    return { ok: false, status: 400, message: 'host did not resolve to a public address' };
  }

  return { ok: true, url };
}
