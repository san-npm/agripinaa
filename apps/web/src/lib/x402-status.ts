'use server';

import { agentBySlug } from '@agripinaa/shared/agents';

import { fetchFromRunner, runnerFailure } from '@/lib/proxy-runner';

/** A status body is a few hundred bytes of numbers plus ten fills; 64 KB is ample. */
const MAX_UPSTREAM_BYTES = 64 * 1024;

/** What the runner said to one unpaid request, reduced to what the panel renders. */
export type StatusEndpointAnswer =
  /** The runner answered; `body` is its JSON, or null when the bytes were not JSON. */
  | { kind: 'answered'; status: number; body: unknown }
  | { kind: 'unknown-agent' }
  /** No answer within 5 s, a refused redirect, or any other transport failure. */
  | { kind: 'unreachable' }
  | { kind: 'oversized' };

/**
 * Ask an agent's x402 status endpoint once, unpaid, from the server, so the
 * browser can show the runner's own 402 challenge without the tunnel's CORS
 * policy (it sets none) in the way. A Server Function rather than a route:
 * it has no URL of its own, only this page's POST, and Next refuses it from
 * any other origin.
 *
 * It is still reachable by anyone who can POST to the page, so the slug is
 * treated as untrusted and checked against the registry before anything is
 * resolved (resolving the runner base may spend a KV command). The call itself
 * is the shared `lib/proxy-runner.ts` one, the same guarded fetch and the same
 * failure split the two managed routes use, so the three of them cannot drift
 * apart on what a dead tunnel means. This caller parses the bytes instead of
 * echoing them, which is why it stops at `fetchFromRunner`. Nothing is thrown:
 * every outcome is a value the panel has a state for.
 */
export async function askStatusEndpoint(slug: string): Promise<StatusEndpointAnswer> {
  if (!agentBySlug(slug)) return { kind: 'unknown-agent' };
  try {
    const upstream = await fetchFromRunner(`/${slug}/status`, {
      timeoutMs: 5_000,
      maxBytes: MAX_UPSTREAM_BYTES,
      maxRedirects: 0,
      headers: { accept: 'application/json' },
    });
    return { kind: 'answered', status: upstream.status, body: parseJson(upstream.bytes) };
  } catch (err) {
    return { kind: runnerFailure(err) };
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
