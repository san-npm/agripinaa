import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSnapshot } from '../src/snapshot';

/**
 * The seeder, driven as the operator drives it: the real script, spawned
 * against a stand-in for the keyed API, writing into a temp dir.
 *
 * What these cover is the decision the script makes about when it has fetched
 * enough, which is the part that has been wrong twice. A resumed run over a
 * file that already holds a target's worth of rows is exactly the state a
 * stopped run leaves behind, and it has to keep fetching from where it stopped.
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(PKG_ROOT, 'node_modules', '.bin', 'tsx');
const OWNER = '0xaad1105c3c4d67bf6f2eef280645cdade81bc427';
/** Rows the stand-in upstream holds: more than any run below asks for. */
const UPSTREAM_ROWS = 1_000;

const asks: { offset: number; limit: number; chainId: string | null }[] = [];
/** Set to make the stand-in refuse from an offset on, the way a stopped run meets a 422. */
let refuseFrom: number | null = null;

function upstreamAgent(chainId: number, index: number) {
  return {
    agent_id: `${chainId}:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:new-${index}`,
    token_id: `new-${index}`,
    chain_id: chainId,
    contract_address: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    owner_address: OWNER,
    name: `Upstream ${index}`,
    description: 'a registration the stand-in upstream serves',
    image_url: null,
    is_verified: false,
    star_count: 0,
    supported_protocols: [],
    x402_supported: false,
    total_score: 0,
    average_score: 0,
    rank: null,
    health_score: null,
    total_feedbacks: 0,
    created_at: '2026-08-20T00:00:00Z',
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.endsWith('/agents')) {
    res.writeHead(404).end('{}');
    return;
  }
  // The seeder is expected to use the keyed surface; an unkeyed request here is
  // the failure the run should never make.
  if (!req.headers['x-api-key']) {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const chainId = url.searchParams.get('chain_id');
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  asks.push({ offset, limit, chainId });
  if (refuseFrom != null && offset >= refuseFrom) {
    // 422 rather than 429 or 5xx: the seeder does not wait and retry on it, so
    // the run stops on this page and prints its resume line.
    res.writeHead(422, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const items = Array.from({ length: Math.max(0, Math.min(limit, UPSTREAM_ROWS - offset)) }, (_, i) =>
    upstreamAgent(Number(chainId), offset + i),
  );
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ items, total: UPSTREAM_ROWS }));
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

/** A committed-looking snapshot of rows an earlier run left behind. */
function snapshotOf(count: number): string {
  const rows = Array.from({ length: count }, (_, i) => JSON.stringify({ t: `old-${i}`, o: OWNER }));
  return `{\n"chainId": 56,\n"seededAt": "2026-08-07T18:38:35.000Z",\n"items": [\n${rows.join(',\n')}\n]\n}\n`;
}

async function seededDir(rows: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-index-seed-'));
  await writeFile(join(dir, 'agents-56.json'), snapshotOf(rows));
  return dir;
}

function runSeed(args: string[], outDir: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(TSX, ['scripts/seed.ts', ...args], {
      cwd: PKG_ROOT,
      env: {
        ...process.env,
        SEED_OUT_DIR: outDir,
        SCAN8004_API_KEY: 'stand-in-key',
        SCAN8004_KEYED_BASE: `http://127.0.0.1:${port}/api/v1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function itemsIn(dir: string) {
  return parseSnapshot(await readFile(join(dir, 'agents-56.json'), 'utf8'))?.items ?? [];
}

test('the resume command a stopped run prints fetches the rest of the target', { timeout: 60_000 }, async () => {
  asks.length = 0;
  const dir = await seededDir(300);

  // A run that dies part way leaves a file of target length: its own rows in
  // front of the rows that were already there. That is the state the resume has
  // to read past, and the state that used to make it fetch nothing.
  refuseFrom = 200;
  const stopped = await runSeed(['--chain', '56', '--target', '300'], dir);
  refuseFrom = null;

  assert.equal(stopped.code, 1);
  assert.equal((await itemsIn(dir)).length, 300, 'the stopped run did not leave a full file');

  const printed = /resume with: pnpm seed:agents -- (.+)/.exec(stopped.stderr)?.[1];
  assert.ok(printed, `no resume command printed:\n${stopped.stderr}`);

  asks.length = 0;
  const resumed = await runSeed(printed.split(' '), dir);

  assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.deepEqual(asks.map((a) => a.offset), [200], 'the printed command fetched nothing, or started over');
  const items = await itemsIn(dir);
  assert.equal(items.length, 300);
  assert.equal(
    items.filter((a) => a.tokenId.startsWith('new-')).length,
    300,
    'the two runs together did not cover the target',
  );
});

test('a resumed run tops up a file that already holds a target of rows', { timeout: 60_000 }, async () => {
  asks.length = 0;
  // What a run that stopped at offset 100 leaves behind: 100 fresh rows in
  // front of the rows that were already there, a full file either way.
  const dir = await seededDir(300);

  const run = await runSeed(['--chain', '56', '--target', '300', '--start', '100'], dir);

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(
    asks.map((a) => a.offset),
    [100, 200],
    'the resumed run fetched nothing, or restarted from the top',
  );
  const items = await itemsIn(dir);
  assert.equal(items.length, 300);
  assert.equal(items.filter((a) => a.tokenId.startsWith('new-')).length, 200);
  assert.equal(items[0]?.tokenId, 'new-100', 'the first row is not the one the run resumed at');
  assert.match(run.stdout, /wrote 300 agents/);
});

test('a fresh run over a full file fetches a target of its own', { timeout: 60_000 }, async () => {
  asks.length = 0;
  const dir = await seededDir(300);

  const run = await runSeed(['--chain', '56', '--target', '300'], dir);

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(
    asks.map((a) => a.offset),
    [0, 100, 200],
  );
  assert.deepEqual(
    asks.map((a) => a.chainId),
    ['56', '56', '56'],
    'the chain filter did not go upstream',
  );
  const items = await itemsIn(dir);
  assert.equal(items.length, 300);
  assert.equal(items.filter((a) => a.tokenId.startsWith('new-')).length, 300);
});

test('a resume offset at the target says so instead of fetching nothing', { timeout: 60_000 }, async () => {
  asks.length = 0;
  const dir = await seededDir(300);
  const before = await readFile(join(dir, 'agents-56.json'), 'utf8');

  const run = await runSeed(['--chain', '56', '--target', '300', '--start', '300'], dir);

  assert.equal(run.code, 1);
  assert.equal(asks.length, 0, 'a run with nothing to fetch still went upstream');
  assert.match(run.stderr, /--target/);
  assert.equal(await readFile(join(dir, 'agents-56.json'), 'utf8'), before);
});
