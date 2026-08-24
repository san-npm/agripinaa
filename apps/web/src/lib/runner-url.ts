import 'server-only';

import { assertSafeUrl } from '@agripinaa/shared/ssrf';

import { kvGet } from './kv';

/**
 * Last-known runner base, committed as the floor so the site still resolves an
 * endpoint with no env var and no KV. Rotations land in KV (see
 * /api/ops/runner-url) and never require a redeploy.
 */
export const DEFAULT_RUNNER_BASE = 'https://continuous-locator-four-christine.trycloudflare.com';

export const RUNNER_URL_KEY = 'agripinaa:runner-url';

/**
 * https only, public host, sane length. The tunnel is an untrusted boundary:
 * this value reaches server-side fetches, so a hostile one is an SSRF into the
 * serverless environment.
 *
 * Host policy is delegated to the shared guard rather than kept as a second
 * list here. That guard covers all of 127.0.0.0/8 and 169.254.0.0/16 (not just
 * the two familiar literals), bracketed IPv6 loopback, ULA and link-local
 * ranges, v4-mapped addresses, and CGNAT, each of which slipped past the
 * hand-rolled set this replaces.
 *
 * DNS is deliberately NOT resolved here: this predicate is synchronous and runs
 * on every read. A hostname that resolves to a private address is caught on the
 * write path, where a candidate first enters (see /api/ops/runner-url), using
 * assertResolvedHostPublic from the same module.
 */
export function isSafeRunnerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return false;
  // Check the scheme before delegating: the shared guard rewrites ipfs:// to an
  // https gateway, which is right for a tokenURI and wrong for a runner base.
  if (!value.startsWith('https://')) return false;
  let url: URL;
  try {
    url = assertSafeUrl(value);
  } catch {
    return false;
  }
  // Userinfo lets one string read as one host to a person and another to a
  // parser downstream, so refuse it rather than reason about who wins.
  if (url.username !== '' || url.password !== '') return false;
  return true;
}

/**
 * Resolution order: AGENTS_BASE_URL (manual override, wins for local dev and
 * incident response) -> KV (self-reported by the VM on every tunnel start) ->
 * the committed default.
 */
export async function runnerBase(): Promise<string> {
  const configured = process.env.AGENTS_BASE_URL?.trim();
  if (isSafeRunnerUrl(configured)) return configured;
  const stored = await kvGet(RUNNER_URL_KEY);
  if (isSafeRunnerUrl(stored)) return stored;
  return DEFAULT_RUNNER_BASE;
}

export async function runnerUrl(path: string): Promise<string> {
  return new URL(path, await runnerBase()).toString();
}
