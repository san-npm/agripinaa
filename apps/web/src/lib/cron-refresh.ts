import 'server-only';

import { CATEGORIES, type Category } from '@agripinaa/agent-index';

import { bearerMatches } from './bearer';
import type { ClaimRecord } from './claims';

/**
 * Everything GET /api/cron/refresh decides and does, kept out of the route so
 * both halves are directly testable: the route only reads the environment, the
 * header, and hands the live dependencies in.
 *
 * The job is the part of the site that no page render can do for itself:
 *
 * 1. Re-probe every claimed endpoint. A liveness record is evidence for 36
 *    hours (see endpoint-probe.ts) and nothing else re-runs a probe after the
 *    claim is saved, so without this the badge decays on every claimed agent.
 * 2. Pre-warm the cached list path once per hub, which also tells us on a fixed
 *    schedule whether the upstream index is answering at all.
 *
 * There is deliberately no KV-backed copy of the index here. A refreshed index
 * would have to fit in KV values the reader tier can consume, and 3,000 BSC
 * registrations do not: the committed snapshot is 750 KB, past the 512 KB per
 * key this would need to stay under, and splitting it across keys would put a
 * multi-key read on the fallback path that today reads one local file. The
 * snapshot stays the offline tier and is refreshed by re-running the seeder.
 */

/** Wall clock for the whole run. Vercel's function ceiling is the reason. */
const DEFAULT_BUDGET_MS = 50_000;

/**
 * Cap on one hub warm, the same 5 s one probe gets (see liveness.ts).
 *
 * The warm path ends in a keyed upstream request and a few chain reads, none of
 * which the caller can cancel. Without a cap of its own, a warm would be raced
 * against everything the run has left, so a single upstream that accepts the
 * connection and then goes quiet would spend the whole budget and leave every
 * claimed endpoint un-probed.
 */
const DEFAULT_WARM_TIMEOUT_MS = 5_000;

/** Endpoints probed at once. Enough to get through the claims, gentle on them. */
const DEFAULT_CONCURRENCY = 4;

export type CronAccess = { ok: true } | { ok: false; status: 401 | 503; message: string };

/**
 * Who may run the refresh: the ops token, or the scheduler's own secret, which
 * Vercel sends as `Authorization: Bearer $CRON_SECRET`. Neither configured
 * closes the route rather than opening it, the same rule the runner-url report
 * follows, so a missing environment variable cannot turn into an open endpoint.
 */
export function decideCronAccess(input: {
  opsToken: string | undefined;
  cronSecret: string | undefined;
  authorization: string | null;
}): CronAccess {
  const tokens = [input.opsToken, input.cronSecret]
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token));
  if (tokens.length === 0) return { ok: false, status: 503, message: 'cron token not configured' };
  if (!tokens.some((token) => bearerMatches(input.authorization, token))) {
    return { ok: false, status: 401, message: 'unauthorized' };
  }
  return { ok: true };
}

/** One agent's claimed endpoint, as the probe addresses it. */
export interface ClaimedEndpoint {
  chainId: number;
  tokenId: string;
  url: string;
}

/**
 * The claims worth probing. A claim without an endpoint has nothing to be live
 * about, so it is counted and left alone.
 */
export function claimedEndpoints(records: ClaimRecord[]): ClaimedEndpoint[] {
  const out: ClaimedEndpoint[] = [];
  for (const record of records) {
    const url = record.fields.endpoint.trim();
    if (!url) continue;
    out.push({ chainId: record.fields.chainId, tokenId: record.fields.tokenId, url });
  }
  return out;
}

export interface RefreshDeps {
  /** Every stored claim. A KV outage is reported, not thrown. */
  listClaims: () => Promise<ClaimRecord[]>;
  /** Probe one endpoint and store the result; answers whether it was live. */
  probe: (target: ClaimedEndpoint) => Promise<boolean>;
  /** Fill the cached list entry one hub page reads. */
  warmHub: (category: Category) => Promise<void>;
  now: () => number;
  budgetMs?: number;
  /** Cap on one hub warm. Defaults to 5 s. */
  warmTimeoutMs?: number;
  concurrency?: number;
}

export interface RefreshCounts {
  /** Claims the index knew about, endpoint or not. */
  claimsSeen: number;
  /** Probes started. Includes ones that timed out or errored. */
  probed: number;
  /** Probes whose endpoint answered. */
  live: number;
  /** Hubs whose cached list entry was filled. */
  warmed: number;
  /** claimsSeen - probed: no endpoint to probe, or no time left to probe it. */
  skipped: number;
  durationMs: number;
  /** What the run did not get through, in plain words. Empty means all of it. */
  unfinished: string[];
}

type Outcome<T> = { status: 'done'; value: T } | { status: 'timeout' } | { status: 'failed' };

/**
 * Run one unit against a deadline. A unit that overruns hands control back so
 * the response can still be written: the work is not cancelled here, it stops
 * being waited on, which is the same shape probeEndpoint uses for its own wall
 * clock. Each leg carries a deadline of its own as well (a probe's 5 s, an
 * upstream request's), so this race is a backstop rather than the only bound.
 */
async function withDeadline<T>(work: () => Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(ms, 0));
  });
  try {
    return await Promise.race([
      work().then(
        (value): Outcome<T> => ({ status: 'done', value }),
        (): Outcome<T> => ({ status: 'failed' }),
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export async function runRefresh(deps: RefreshDeps): Promise<RefreshCounts> {
  const startedAt = deps.now();
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const warmTimeoutMs = deps.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const remaining = () => budgetMs - (deps.now() - startedAt);
  const unfinished: string[] = [];

  // Probes first. Liveness is the half nothing else re-runs: a stored result is
  // evidence for 36 hours and no page render refreshes it, so a claim that
  // misses two runs loses its badge. A hub that misses its warm costs one cold
  // page render, and a visitor warms it anyway.
  let records: ClaimRecord[] = [];
  try {
    records = await deps.listClaims();
  } catch {
    // Claims are an enrichment everywhere else too: report it and carry on.
    unfinished.push('claims could not be listed');
  }

  const queue = claimedEndpoints(records);
  let next = 0;
  let probed = 0;
  let live = 0;
  let timedOut = 0;

  async function worker(): Promise<void> {
    while (next < queue.length && remaining() > 0) {
      const target = queue[next++]!;
      probed++;
      const outcome = await withDeadline(() => deps.probe(target), remaining());
      if (outcome.status === 'done' && outcome.value) live++;
      if (outcome.status === 'timeout') timedOut++;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()),
  );

  const notProbed = queue.length - probed;
  if (notProbed > 0) {
    unfinished.push(
      `${plural(notProbed, 'claimed endpoint', 'claimed endpoints')} not re-probed within the budget`,
    );
  }
  if (timedOut > 0) {
    unfinished.push(`${plural(timedOut, 'endpoint probe', 'endpoint probes')} timed out`);
  }

  // Then the hubs, each against its own cap as well as the budget, so what is
  // left of the run is spent on the four of them rather than on the first one.
  let warmed = 0;
  for (const category of CATEGORIES) {
    const allowance = Math.min(remaining(), warmTimeoutMs);
    const outcome =
      allowance > 0
        ? await withDeadline(() => deps.warmHub(category), allowance)
        : ({ status: 'timeout' } as const);
    if (outcome.status === 'done') warmed++;
    else unfinished.push(`hub ${category} not warmed`);
  }

  return {
    claimsSeen: records.length,
    probed,
    live,
    warmed,
    skipped: records.length - probed,
    durationMs: deps.now() - startedAt,
    unfinished,
  };
}
