import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rankByExecution } from '../src/lib/leaderboard';

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
