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
 * Progress is written after every page, so a rate limit, a network drop, or a
 * Ctrl-C keeps everything already fetched. Restart from where it stopped with
 * `--start <offset>`: the run merges into the rows already on disk and dedupes
 * by token id, which also absorbs the shift that new registrations cause at
 * the head of an offset-paginated list.
 *
 * Usage:
 *   export $(grep '^SCAN8004_API_KEY=' apps/web/.env.local)   # never commit it
 *   pnpm seed:agents [-- --chain 56 --target 3000 --start 0]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeSnapshot, parseSnapshot } from '../src/snapshot';
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
  return status === 429 || (status != null && status >= 500);
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
  const byTokenId = new Map<string, AgentSummary>();
  if (START_OFFSET > 0) {
    for (const item of await loadExisting()) byTokenId.set(item.tokenId, item);
    console.log(`resuming at offset ${START_OFFSET} with ${byTokenId.size} rows already on disk`);
  }

  let offset = START_OFFSET;
  let retried = false;
  let upstreamTotal: number | null = null;

  while (byTokenId.size < TARGET) {
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
      console.error(`stopped at offset ${offset}: ${message}`);
      console.error(`resume with: pnpm seed:agents -- --chain ${CHAIN_ID} --start ${offset}`);
      break;
    }
    retried = false;
    upstreamTotal = page.total ?? upstreamTotal;

    let added = 0;
    for (const item of page.items) {
      if (byTokenId.has(item.tokenId)) continue;
      byTokenId.set(item.tokenId, item);
      added++;
    }
    const items = [...byTokenId.values()];
    await write(items, seededAt);
    console.log(
      `offset ${offset}: +${added} of ${page.items.length} (total ${items.length}` +
        `${upstreamTotal != null ? ` of ${upstreamTotal} upstream` : ''})`,
    );

    if (!page.nextCursor) break;
    offset = Number.parseInt(page.nextCursor, 10);
    await sleep(REQUEST_GAP_MS);
  }

  const items = [...byTokenId.values()].slice(0, TARGET);
  await write(items, seededAt);

  const counts = hubCounts(items);
  const classified = items.length - counts.none;
  console.log(`wrote ${items.length} agents to ${outFile}`);
  console.log(
    `classified ${classified} of ${items.length}: ` +
      CATEGORIES.map((c) => `${c} ${counts[c]}`).join(', '),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
