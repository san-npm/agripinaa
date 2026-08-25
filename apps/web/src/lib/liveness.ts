import 'server-only';

import type { AgentSummary } from '@agripinaa/agent-index';
import { BlockedUrlError, safeFetchBytes } from '@agripinaa/shared/ssrf';

import { normalizeAgentId } from './claim-message';
import { kvGet, kvMGet, kvSet } from './kv';

/**
 * Whether a claimed agent's own endpoint answers, and where that answer is kept.
 *
 * A claimed endpoint is a claim until something answers it, so activation for a
 * third-party agent turns on this record rather than on the claim alone. The
 * probe never runs on a page render: it runs once when a claim is saved and
 * again from the re-probe cron, and every reader works off the stored result.
 *
 * Storage is the same minimal KV client the claims use, which has no TTL and no
 * list command. So the record carries `checkedAt` and readers apply the window
 * themselves (`countsAsLive`): a result nobody refreshed decays into "not live"
 * instead of lingering as a badge for an endpoint that went away.
 */

/** How long a stored probe result counts for. Past this it is not evidence. */
export const LIVENESS_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Cap on one probe, measured on the wall clock from the call to the answer.
 *
 * The guard's own `timeoutMs` is per redirect hop and its dns lookups sit
 * outside it, so passing it alone would cap a hop rather than the probe, and a
 * host that redirects and then stalls could hold a request open for a multiple
 * of this. `probeEndpoint` enforces the number itself.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Redirect hops a probe follows. One, so an endpoint served behind a trailing
 * slash or a canonical host still answers, while a chain cannot spend the
 * budget several times over. Each hop is revalidated by the guard.
 */
const PROBE_MAX_REDIRECTS = 1;

const LIVENESS_PREFIX = 'agripinaa:liveness:';

/**
 * The KV key for one agent's liveness. The id is normalised here rather than by
 * each caller, so a claim signed for `000297380` and a listing for `297380`
 * land on the same key.
 */
export function livenessKey(chainId: number, tokenId: string): string {
  return `${LIVENESS_PREFIX}${chainId}:${normalizeAgentId(tokenId)}`;
}

/** Why a probe did not count as an answer. Absent when the endpoint answered. */
export type LivenessReason = 'blocked' | 'timeout' | 'unreachable' | 'status';

export interface ProbeResult {
  live: boolean;
  /** ISO 8601 instant the probe ran, which is what the window is measured from. */
  checkedAt: string;
  /** The status the endpoint answered with, when it answered at all. */
  status?: number;
  reason?: LivenessReason;
}

export interface LivenessRecord extends ProbeResult {
  /**
   * The url that was probed. Stored so a record cannot outlive the endpoint it
   * is about: an owner who re-claims with a different endpoint gets no badge
   * from the answer the old one gave.
   */
  url: string;
}

export interface ProbeOptions {
  /** Clock, injectable so a test can pin `checkedAt` and the freshness window. */
  now?: () => number;
  /** Whole-probe budget in ms, dns and redirects included. Defaults to 5 s. */
  timeoutMs?: number;
  /**
   * Transport, injectable so a test can answer for an endpoint without the
   * network and without swapping the process-wide fetch. It is handed to the
   * guard, not used instead of it: the url is validated and each redirect hop
   * revalidated before this is called. Defaults to the global fetch.
   */
  fetchImpl?: typeof fetch;
}

/** One agent, as the list paths address them. */
export interface AgentRef {
  chainId: number;
  tokenId: string;
}

/**
 * A 2xx or 3xx is an answer; so is a 401 (the endpoint wants credentials) and a
 * 402 (an x402 paywall quoting its price, which is exactly the endpoint working).
 * Anything else is a host that answered without an agent behind it.
 *
 * A 3xx rarely reaches here: the guard follows the one permitted hop itself,
 * revalidating it, and hands back the status at the end of it.
 */
function statusCountsAsLive(status: number): boolean {
  return (status >= 200 && status < 400) || status === 401 || status === 402;
}

/**
 * A url the guard refused, a probe that ran out of time, and a host that never
 * answered are three different things to an owner debugging their endpoint, so
 * the record says which. `blocked` also covers a redirect chain longer than the
 * one hop a probe follows, which the guard refuses by the same rule. An
 * oversized body reads as `unreachable`: the guard cancels the stream
 * mid-flight, so no status ever comes back from it.
 */
function failureReason(error: unknown): LivenessReason {
  if (error instanceof BlockedUrlError) return 'blocked';
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
}

/**
 * One pass at the endpoint, through the shared SSRF guard: the url is
 * validated before anything connects and every redirect hop is revalidated, so
 * an owner cannot point a claim at an internal address and have this site fetch
 * it. Nothing reads the body: only the status decides.
 */
async function probeThroughGuard(
  url: string,
  budgetMs: number,
  checkedAt: string,
  fetchImpl?: typeof fetch,
): Promise<ProbeResult> {
  try {
    const res = await safeFetchBytes(url, {
      timeoutMs: budgetMs,
      maxRedirects: PROBE_MAX_REDIRECTS,
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
      fetchImpl,
    });
    return statusCountsAsLive(res.status)
      ? { live: true, checkedAt, status: res.status }
      : { live: false, checkedAt, status: res.status, reason: 'status' };
  } catch (error) {
    return { live: false, checkedAt, reason: failureReason(error) };
  }
}

/**
 * Probe one endpoint. Never throws: every failure is an answer about the
 * endpoint, and a caller storing the result wants the reason, not an exception.
 *
 * Answers within `timeoutMs` whatever the endpoint does. The guard times each
 * hop separately and its dns lookups have no timer at all, so a host that
 * redirects once and then stalls could otherwise hold this open for several
 * times the budget; the caller in the claim POST awaits this, so the number has
 * to be a wall clock. A probe that runs out of time is reported as a timeout,
 * which is the same answer it would give at the connection level.
 */
export async function probeEndpoint(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const checkedAt = new Date(opts.now?.() ?? Date.now()).toISOString();
  const budgetMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ProbeResult>((resolve) => {
    deadline = setTimeout(() => resolve({ live: false, checkedAt, reason: 'timeout' }), budgetMs);
  });
  try {
    return await Promise.race([
      probeThroughGuard(url, budgetMs, checkedAt, opts.fetchImpl),
      expired,
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Probe an agent's endpoint and store what came back. Returns the record either
 * way: a KV that is unconfigured or unreachable costs the badge, not the answer,
 * so a caller can still act on it.
 */
export async function recordLiveness(
  chainId: number,
  tokenId: string,
  url: string,
  opts: ProbeOptions = {},
): Promise<LivenessRecord> {
  const record: LivenessRecord = { url, ...(await probeEndpoint(url, opts)) };
  const id = normalizeAgentId(tokenId);
  if (id) await kvSet(livenessKey(chainId, id), JSON.stringify(record));
  return record;
}

function parseRecord(raw: string | null): LivenessRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LivenessRecord>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.url !== 'string' || typeof parsed.live !== 'boolean') return null;
    if (typeof parsed.checkedAt !== 'string') return null;
    const record: LivenessRecord = { url: parsed.url, live: parsed.live, checkedAt: parsed.checkedAt };
    if (typeof parsed.status === 'number') record.status = parsed.status;
    if (typeof parsed.reason === 'string') record.reason = parsed.reason as LivenessReason;
    return record;
  } catch {
    return null;
  }
}

/** The stored probe result for one agent, however old it is. */
export async function getLiveness(chainId: number, tokenId: string): Promise<LivenessRecord | null> {
  const id = normalizeAgentId(tokenId);
  if (!id) return null;
  return parseRecord(await kvGet(livenessKey(chainId, id)));
}

/**
 * The stored results for many agents, one answer per id and in the same order
 * (null where there is none). One batched MGET, so a listing costs a single
 * round trip however many claimed agents are on it.
 */
export async function getLivenessMany(ids: AgentRef[]): Promise<(LivenessRecord | null)[]> {
  if (ids.length === 0) return [];
  const values = await kvMGet(ids.map(({ chainId, tokenId }) => livenessKey(chainId, tokenId)));
  return values.map(parseRecord);
}

/**
 * Whether a stored record still says this endpoint is live: it has to be about
 * the url the listing carries now, say live, and sit inside the window. Every
 * reader (both gates, both badges) asks this one question, so a card and a
 * profile cannot disagree about the same agent.
 */
export function countsAsLive(
  record: LivenessRecord | null,
  url: string,
  now: number = Date.now(),
): boolean {
  if (!record || !record.live) return false;
  if (record.url.trim() !== url.trim()) return false;
  const checkedAt = Date.parse(record.checkedAt);
  return Number.isFinite(checkedAt) && now - checkedAt < LIVENESS_TTL_MS;
}

/**
 * Mark the listings whose claimed endpoint answered inside the window.
 *
 * One batched read, for the claimed ids only: an endpoint reaches a listing
 * through its owner's claim, so an unclaimed card has nothing to be live about
 * and costs nothing here. A listing that ends up with no fresh result is
 * returned untouched, which is what a card renders as no badge.
 */
export async function withLiveness(agents: AgentSummary[]): Promise<AgentSummary[]> {
  const claimed = agents.filter((a) => a.claimed === true && (a.endpoint ?? '').trim() !== '');
  if (claimed.length === 0) return agents;
  const records = await getLivenessMany(
    claimed.map(({ chainId, tokenId }) => ({ chainId, tokenId })),
  ).catch(() => []);
  const live = new Set<string>();
  claimed.forEach((agent, i) => {
    if (countsAsLive(records[i] ?? null, agent.endpoint ?? '')) live.add(agent.id);
  });
  if (live.size === 0) return agents;
  return agents.map((a) => (live.has(a.id) ? { ...a, endpointLive: true } : a));
}
