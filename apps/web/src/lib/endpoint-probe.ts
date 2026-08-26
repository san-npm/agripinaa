/**
 * What a liveness probe found, and how it is said in one line.
 *
 * Isomorphic on purpose (no `server-only`, no KV, no fetch): the claim form is
 * a client component and renders the result the POST answered with, while the
 * agent profile is a server component and renders the result KV holds. Both
 * read the same reason through this module, so an owner debugging an endpoint
 * is told the same thing wherever they look at it.
 *
 * `lib/liveness.ts` owns the probing and the storage, and its `LivenessRecord`
 * is this shape: the record is declared here so the browser never pulls a
 * server-only module in to name it.
 */

/** Why a probe did not count as an answer. Absent when the endpoint answered. */
export const PROBE_REASONS = ['blocked', 'timeout', 'unreachable', 'status'] as const;
export type ProbeReason = (typeof PROBE_REASONS)[number];

export interface EndpointProbe {
  /** The url that was probed, so a result cannot outlive the endpoint it is about. */
  url: string;
  live: boolean;
  /** ISO 8601 instant the probe ran, which is what the window is measured from. */
  checkedAt: string;
  /** The status the endpoint answered with, when it answered at all. */
  status?: number;
  reason?: ProbeReason;
}

/**
 * How long a stored probe result counts for. Past this it is not evidence: the
 * KV client has no TTL, so a result nobody refreshed decays here instead of
 * lingering as a badge for an endpoint that went away.
 */
export const LIVENESS_TTL_MS = 24 * 60 * 60 * 1_000;

/** Whether a result still says this endpoint is live, for the url it carries now. */
export function probeCountsAsLive(
  probe: EndpointProbe | null,
  url: string,
  now: number = Date.now(),
): boolean {
  if (!probe || !probe.live) return false;
  if (probe.url.trim() !== url.trim()) return false;
  const checkedAt = Date.parse(probe.checkedAt);
  return Number.isFinite(checkedAt) && now - checkedAt < LIVENESS_TTL_MS;
}

const REASON_TEXT: Record<ProbeReason, string> = {
  blocked: 'the url was refused before we connected (a private host, or too many redirects)',
  timeout: 'no answer within the probe timeout',
  unreachable: 'the host did not answer',
  // Replaced with the status itself where there is one; a probe that reports
  // this reason always has one, and this is what is said if it ever does not.
  status: 'the endpoint answered without an agent behind it',
};

/**
 * One line saying what our probe found about `url`, for a reader who wants to
 * know why their endpoint carries no badge. Never quotes anything the endpoint
 * sent: the status is a number and the rest is this module's own wording.
 */
export function endpointProbeLabel(
  probe: EndpointProbe | null,
  url: string,
  now: number = Date.now(),
): string {
  if (!probe || probe.url.trim() !== url.trim()) return 'not checked yet';
  if (probe.live) {
    if (!probeCountsAsLive(probe, url, now)) {
      return 'not live: nothing has answered in the last 24 hours';
    }
    return probe.status ? `live, answered ${probe.status}` : 'live';
  }
  if (probe.reason === 'status' && probe.status) return `not live: answered ${probe.status}`;
  return probe.reason ? `not live: ${REASON_TEXT[probe.reason]}` : 'not live';
}

/**
 * A probe result out of an untrusted body (the claim POST answers with one).
 * Field by field, so nothing the response carries beyond the record reaches a
 * reader, and an unknown reason is dropped rather than rendered.
 */
export function readEndpointProbe(value: unknown): EndpointProbe | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<EndpointProbe>;
  if (typeof raw.url !== 'string' || typeof raw.live !== 'boolean') return null;
  if (typeof raw.checkedAt !== 'string') return null;
  const probe: EndpointProbe = { url: raw.url, live: raw.live, checkedAt: raw.checkedAt };
  if (typeof raw.status === 'number' && Number.isFinite(raw.status)) probe.status = raw.status;
  if (typeof raw.reason === 'string' && (PROBE_REASONS as readonly string[]).includes(raw.reason)) {
    probe.reason = raw.reason;
  }
  return probe;
}
