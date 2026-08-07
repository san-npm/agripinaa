/**
 * Snapshot seeder: paginates 8004scan's BSC agent list at anonymous-tier
 * pace (1 request / 6s ≈ 10/min) and writes data/agents-<chain>.json, the
 * committed fallback used when the live API is unavailable or rate-limited.
 *
 * Usage: pnpm seed:agents [-- --chain 56 --pages 20 --limit 100]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Scan8004Source } from '../src/sources/scan8004';
import type { AgentSummary } from '../src/types';

function arg(name: string, fallbackValue: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

const CHAIN_ID = arg('chain', 56);
const MAX_PAGES = arg('pages', 20);
const PAGE_SIZE = arg('limit', 100);
const DELAY_MS = 6_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const source = new Scan8004Source();
  const items: AgentSummary[] = [];
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await source.listAgents({
      chainId: CHAIN_ID,
      cursor,
      limit: PAGE_SIZE,
    });
    items.push(...res.items);
    console.log(
      `page ${page}: +${res.items.length} (total ${items.length}${res.total != null ? ` of ${res.total} upstream` : ''})`,
    );
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
    await sleep(DELAY_MS);
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `agents-${CHAIN_ID}.json`);
  await writeFile(
    outFile,
    JSON.stringify(
      { chainId: CHAIN_ID, seededAt: new Date().toISOString(), items },
      null,
      2,
    ),
  );
  console.log(`wrote ${items.length} agents to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
