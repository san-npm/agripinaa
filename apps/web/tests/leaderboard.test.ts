import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatherExecutionRows, rankByExecution } from '../src/lib/leaderboard';

const rows = [
  { tokenId: '1', name: 'A', fills: 20, avgSurplusBps: 10, firstSeen: '2026-08-01T00:00:00.000Z' },
  { tokenId: '2', name: 'B', fills: 3, avgSurplusBps: 90, firstSeen: '2026-08-20T00:00:00.000Z' },
  { tokenId: '3', name: 'C', fills: 0, avgSurplusBps: 0, firstSeen: '2026-08-22T00:00:00.000Z' },
];

test('agents with no fills rank last and are labelled', () => {
  const ranked = rankByExecution(rows);
  assert.equal(ranked.at(-1)?.tokenId, '3');
  assert.equal(ranked.at(-1)?.unranked, true);
});

test('a thin sample cannot outrank a deep one on average alone', () => {
  const ranked = rankByExecution(rows);
  assert.equal(ranked[0]?.tokenId, '1');
});

test('ranking is stable for identical inputs', () => {
  assert.deepEqual(rankByExecution(rows), rankByExecution(rows));
});

/** Two registered agents plus one still in configuration, which has no record. */
const agents = [
  { tokenId: '1', name: 'A', category: 'grid' as const, wallet: '0xa1' as const },
  { tokenId: '2', name: 'B', category: 'yield' as const, wallet: '0xb2' as const },
  { tokenId: null, name: 'C', category: 'grid' as const, wallet: null },
];

const record = (fills: number, avgSurplusBps: number | null) => ({
  fills,
  avgSurplusBps,
  bestFillBps: avgSurplusBps,
  firstSeen: '2026-08-01T00:00:00.000Z',
});

test('an agent with no token id or no wallet is left out entirely', async () => {
  const rows = await gatherExecutionRows(agents, async () => record(4, 12));
  assert.deepEqual(rows.map((row) => row.tokenId), ['1', '2']);
});

/**
 * /leaderboard is prerendered, so one orderbook failure taking the whole page
 * down takes the build with it. The failing agent has to degrade to a row.
 */
test('one settlement fetch failing leaves the rest of the table standing', async () => {
  const rows = await gatherExecutionRows(agents, async (wallet) => {
    if (wallet === '0xa1') throw new Error('cow orderbook 502');
    return record(4, 12);
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    tokenId: '1',
    name: 'A',
    category: 'grid',
    fills: 0,
    avgSurplusBps: null,
    firstSeen: null,
    unavailable: true,
  });
  assert.equal(rows[1]?.unavailable, false);
  assert.equal(rows[1]?.fills, 4);
});

test('an agent whose settlements could not be read is ranked nowhere', async () => {
  const rows = await gatherExecutionRows(agents, async (wallet) => {
    if (wallet === '0xa1') throw new Error('cow orderbook 502');
    return record(4, 12);
  });
  const ranked = rankByExecution(rows);
  const failed = ranked.find((row) => row.tokenId === '1');
  assert.equal(failed?.unranked, true);
  assert.equal(failed?.rank, null);
  assert.equal(ranked.find((row) => row.tokenId === '2')?.rank, 1);
});

test('every fetch failing still produces a table rather than a rejection', async () => {
  const rows = await gatherExecutionRows(agents, async () => {
    throw new Error('cow orderbook 502');
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.unavailable));
});
