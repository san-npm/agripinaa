import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeSnapshot, mergeSnapshotItems, parseSnapshot } from '../src/snapshot';
import type { AgentSummary } from '../src/types';

const SEEDED_AT = '2026-08-25T12:00:00.000Z';

function bare(tokenId: string): AgentSummary {
  return {
    id: `56-${tokenId}`,
    chainId: 56,
    tokenId,
    agentId: `56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:${tokenId}`,
    name: `Agent #${tokenId}`,
    description: '',
    imageUrl: null,
    owner: '0xaad1105c3c4d67bf6f2eef280645cdade81bc427',
    category: null,
    supportedProtocols: [],
    x402Supported: false,
    registeredAt: '2026-08-07T18:38:35Z',
    trust: {
      totalScore: 0,
      averageScore: 0,
      rank: null,
      healthScore: null,
      totalFeedbacks: 0,
      starCount: 0,
      isVerified: false,
      source: '8004scan',
      asOf: SEEDED_AT,
    },
  };
}

function populated(): AgentSummary {
  return {
    ...bare('303491'),
    name: 'Grid B',
    description: 'a grid trading agent on BNB Chain',
    imageUrl: 'https://example.test/a.png',
    category: 'grid',
    supportedProtocols: ['A2A', 'Web'],
    x402Supported: true,
    trust: {
      totalScore: 42,
      averageScore: 4.2,
      rank: 7,
      healthScore: 91,
      totalFeedbacks: 10,
      starCount: 3,
      isVerified: true,
      breakdown: { quality: 80, activity: 60 },
      source: '8004scan',
      asOf: SEEDED_AT,
    },
  };
}

function roundTrip(items: AgentSummary[]): AgentSummary[] {
  const parsed = parseSnapshot(encodeSnapshot({ chainId: 56, seededAt: SEEDED_AT, items }));
  assert.ok(parsed, 'snapshot did not parse');
  return parsed.items;
}

test('round-trips a populated agent through the compact rows', () => {
  assert.deepEqual(roundTrip([populated()]), [populated()]);
});

test('round-trips a bare registration, which is most of the registry', () => {
  assert.deepEqual(roundTrip([bare('258571')]), [bare('258571')]);
});

test('keeps the envelope the snapshot has always had', () => {
  const raw = JSON.parse(encodeSnapshot({ chainId: 56, seededAt: SEEDED_AT, items: [bare('1')] }));
  assert.deepEqual(Object.keys(raw), ['chainId', 'seededAt', 'items']);
  assert.equal(raw.chainId, 56);
  assert.equal(raw.seededAt, SEEDED_AT);
});

test('a bare registration stores only what cannot be derived or defaulted', () => {
  // The point of the shape: 3,000 rows of this is the whole file. Anything a
  // reader can rebuild (id, agentId, chain, placeholder name, zeroed trust) is
  // not written, so a row is the token, its owner, and its registration time.
  const [row] = JSON.parse(
    encodeSnapshot({ chainId: 56, seededAt: SEEDED_AT, items: [bare('258571')] }),
  ).items;
  assert.deepEqual(Object.keys(row).sort(), ['o', 'r', 't']);
});

test('the compact file is a fraction of the size of the full records', () => {
  const items = Array.from({ length: 200 }, (_, i) => bare(String(258000 + i)));
  const compact = encodeSnapshot({ chainId: 56, seededAt: SEEDED_AT, items }).length;
  const full = JSON.stringify({ chainId: 56, seededAt: SEEDED_AT, items }).length;
  assert.ok(compact * 3 < full, `compact ${compact} is not much smaller than full ${full}`);
});

test('an agentId the chain cannot derive is stored rather than rebuilt wrong', () => {
  const odd: AgentSummary = { ...bare('99'), agentId: '56:0xsomeotherregistry:99' };
  assert.deepEqual(roundTrip([odd]), [odd]);
});

test('reads the full-record shape the snapshot used before', () => {
  const legacy = JSON.stringify({ chainId: 56, seededAt: SEEDED_AT, items: [populated()] });
  const parsed = parseSnapshot(legacy);
  assert.ok(parsed);
  assert.deepEqual(parsed.items, [populated()]);
});

test('answers null for anything that is not a snapshot', () => {
  assert.equal(parseSnapshot('not json'), null);
  assert.equal(parseSnapshot('{"chainId":56}'), null);
  assert.equal(parseSnapshot('[]'), null);
});

test('skips rows with no token id instead of inventing one', () => {
  const parsed = parseSnapshot(
    JSON.stringify({ chainId: 56, seededAt: SEEDED_AT, items: [{ o: '0xowner' }, { t: '7', o: '0xowner' }] }),
  );
  assert.ok(parsed);
  assert.deepEqual(
    parsed.items.map((a) => a.tokenId),
    ['7'],
  );
});

// What the seeder writes after every page. A seed run replaces the committed
// file, so the rule these cover is: a run can only add rows or refresh them,
// never leave the offline tier with less than it had.

test('a run that stopped early keeps its rows and fills the rest from the file on disk', () => {
  const fetched = [bare('900'), bare('901')];
  const onDisk = [bare('100'), bare('101'), bare('102')];
  assert.deepEqual(
    mergeSnapshotItems({ fetched, onDisk, keep: 5 }).map((a) => a.tokenId),
    ['900', '901', '100', '101', '102'],
  );
});

test('a fetched row replaces the copy already on disk', () => {
  const fresh: AgentSummary = { ...bare('100'), name: 'Renamed Since The Last Seed' };
  const merged = mergeSnapshotItems({ fetched: [fresh], onDisk: [bare('100'), bare('101')], keep: 5 });
  assert.deepEqual(merged.map((a) => a.tokenId), ['100', '101']);
  assert.equal(merged[0]?.name, 'Renamed Since The Last Seed');
});

test('a run that fetched nothing leaves the file exactly as it was', () => {
  const onDisk = [bare('100'), bare('101')];
  assert.deepEqual(mergeSnapshotItems({ fetched: [], onDisk, keep: 3000 }), onDisk);
});

test('the row cap drops the oldest rows, never a freshly fetched one', () => {
  const fetched = [bare('900'), bare('901')];
  const onDisk = [bare('100'), bare('101'), bare('102')];
  assert.deepEqual(
    mergeSnapshotItems({ fetched, onDisk, keep: 3 }).map((a) => a.tokenId),
    ['900', '901', '100'],
  );
  // A cap below what this run fetched still keeps every fetched row: the cap is
  // about how much history to carry, not about throwing away new work.
  assert.deepEqual(
    mergeSnapshotItems({ fetched, onDisk, keep: 1 }).map((a) => a.tokenId),
    ['900', '901'],
  );
});
