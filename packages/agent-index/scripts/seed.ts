/**
 * Snapshot seeder: paginates 8004scan's keyed BSC agent list and writes
 * data/agents-<chain>.json, the committed fallback the site lists from when
 * the live indexer is unavailable or rate limited.
 *
 * The keyed surface is the one worth seeding from: its `chain_id` filter works
 * server-side (the public one ignores it and answers with the global set), it
 * caps a page at 100, and it allows 180 requests a minute. Requests go out one
 * every 400 ms, which is 150 a minute with room to spare.
 *
 * Every write merges what this run fetched over what the file already held,
 * newest first, so a run can only add rows or refresh them. That matters
 * because the file is the site's offline tier and a seed run replaces it: a
 * stop on page five (an expired key, a 422, a dropped connection) leaves five
 * pages of fresh rows in front of the rows that were already there, and a run
 * that fetched nothing leaves the file untouched rather than emptying it.
 * Within a run, rows are deduped by token id, which absorbs the shift that new
 * registrations cause at the head of an offset-paginated list.
 *
 * Progress is written after every page, so a rate limit, a network drop, or a
 * Ctrl-C keeps everything already fetched. Restart from where it stopped with
 * `--start <offset>`, which tops the file back up to the target instead of
 * fetching a whole target's worth again.
 *
 * Usage:
 *   export $(grep '^SCAN8004_API_KEY=' apps/web/.env.local)   # never commit it
 *   pnpm seed:agents [-- --chain 56 --target 3000 --start 0]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeSnapshot, mergeSnapshotItems, parseSnapshot } from '../src/snapshot';
import { Scan8004Error, Scan8004Source } from '../src/sources/scan8004';
import { CATEGORIES, type AgentSummary, type Category } from '../src/types';

function arg(name: string, fallbackValue: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

const CHAIN_ID = arg('chain', 56);
/** Rows to end up with. The floor this snapshot is expected to carry is 2,000. */
const TARGET = arg('target', 3_000);
/** Where to resume an interrupted run. */
const START_OFFSET = arg('start', 0);
/** The keyed surface caps a page at 100 and rejects anything larger with a 422. */
const PAGE_SIZE = 100;
/** 400 ms between requests is 150/min against a 180/min allowance. */
const REQUEST_GAP_MS = 400;
/** One pause-and-retry when the API pushes back, before giving up on the run. */
const BACKOFF_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const outFile = join(outDir, `agents-${CHAIN_ID}.json`);

async function loadExisting(): Promise<AgentSummary[]> {
  try {
    return parseSnapshot(await readFile(outFile, 'utf8'))?.items ?? [];
  } catch {
    return [];
  }
}

async function write(items: AgentSummary[], seededAt: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, encodeSnapshot({ chainId: CHAIN_ID, seededAt, items }));
}

/** Retryable in the sense that waiting is the right response: rate limit, or upstream trouble. */
function worthRetrying(err: unknown): boolean {
  const status = err instanceof Scan8004Error ? err.status : undefined;
  if (status === 429 || (status != null && status >= 500)) return true;
  // A request that hit its own deadline is the same kind of trouble: the page
  // is worth asking for again once, from the offset the run is already at.
  return err instanceof Error && err.name === 'TimeoutError';
}

function hubCounts(items: AgentSummary[]): Record<Category | 'none', number> {
  const counts = { none: 0 } as Record<Category | 'none', number>;
  for (const category of CATEGORIES) counts[category] = 0;
  for (const item of items) counts[item.category ?? 'none']++;
  return counts;
}

async function main() {
  if (!process.env.SCAN8004_API_KEY) {
    // Seeding from the anonymous surface would take the global, mixed-chain
    // list at one request per six seconds. Ask for the key rather than write a
    // snapshot that is neither BSC nor large.
    throw new Error(
      'SCAN8004_API_KEY is not set. Export it into this shell before seeding ' +
        "(it lives in apps/web/.env.local: export $(grep '^SCAN8004_API_KEY=' apps/web/.env.local)).",
    );
  }

  const source = new Scan8004Source();
  const seededAt = new Date().toISOString();
  const onDisk = await loadExisting();
  /** Rows to end up with: the target, or what the file already had if that is more. */
  const keep = Math.max(TARGET, onDisk.length);
  const fetched = new Map<string, AgentSummary>();
  const merged = () => mergeSnapshotItems({ fetched: [...fetched.values()], onDisk, keep });
  if (onDisk.length > 0) {
    console.log(
      `${onDisk.length} rows already in ${outFile}` +
        `${START_OFFSET > 0 ? `, resuming at offset ${START_OFFSET}` : ''}; ` +
        'this run adds to them and never writes fewer',
    );
  }

  let offset = START_OFFSET;
  let retried = false;
  let upstreamTotal: number | null = null;
  let stoppedEarly = false;

  // A resumed run tops the file back up to the target; a fresh one fetches a
  // target's worth of its own rather than stopping at what is already there.
  const progress = () => (START_OFFSET > 0 ? merged().length : fetched.size);

  while (progress() < TARGET) {
    let page;
    try {
      page = await source.listAgents({ chainId: CHAIN_ID, cursor: String(offset), limit: PAGE_SIZE });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (worthRetrying(err) && !retried) {
        retried = true;
        console.warn(`${message}; waiting ${BACKOFF_MS / 1_000}s and retrying once`);
        await sleep(BACKOFF_MS);
        continue;
      }
      // Everything fetched so far is already on disk, page by page.
      stoppedEarly = true;
      console.error(`stopped at offset ${offset}: ${message}`);
      console.error(`resume with: pnpm seed:agents -- --chain ${CHAIN_ID} --start ${offset}`);
      break;
    }
    retried = false;
    upstreamTotal = page.total ?? upstreamTotal;

    let added = 0;
    for (const item of page.items) {
      if (fetched.has(item.tokenId)) continue;
      fetched.set(item.tokenId, item);
      added++;
    }
    if (fetched.size > 0) await write(merged(), seededAt);
    console.log(
      `offset ${offset}: +${added} of ${page.items.length} (fetched ${fetched.size}` +
        `${upstreamTotal != null ? ` of ${upstreamTotal} upstream` : ''})`,
    );

    if (!page.nextCursor) break;
    offset = Number.parseInt(page.nextCursor, 10);
    await sleep(REQUEST_GAP_MS);
  }

  if (fetched.size === 0) {
    // Nothing to write but a worse file: a first-page 401 or 422 would otherwise
    // replace the offline tier with an empty snapshot, which reads as valid.
    console.error(`fetched nothing; left the ${onDisk.length} rows in ${outFile} alone`);
    process.exitCode = 1;
    return;
  }

  const items = merged();
  await write(items, seededAt);

  const counts = hubCounts(items);
  const classified = items.length - counts.none;
  console.log(
    `wrote ${items.length} agents to ${outFile} ` +
      `(${fetched.size} from this run, ${items.length - fetched.size} carried over)`,
  );
  console.log(
    `classified ${classified} of ${items.length}: ` +
      CATEGORIES.map((c) => `${c} ${counts[c]}`).join(', '),
  );
  // An incomplete run is not a successful seed, even though its rows are kept.
  if (stoppedEarly) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
