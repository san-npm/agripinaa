import 'server-only';

import { kvGet } from './kv';

/**
 * Last-known runner base, committed as the floor so the site still resolves an
 * endpoint with no env var and no KV. Rotations land in KV (see
 * /api/ops/runner-url) and never require a redeploy.
 */
export const DEFAULT_RUNNER_BASE = 'https://continuous-locator-four-christine.trycloudflare.com';

export const RUNNER_URL_KEY = 'agripinaa:runner-url';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);

/** https only, public host, sane length. The tunnel is an untrusted boundary. */
export function isSafeRunnerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return false;
  }
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
