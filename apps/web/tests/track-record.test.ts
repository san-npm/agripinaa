import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateTrackRecord } from '../src/lib/exec';

/** The three fields of an execution row the aggregation actually reads. */
function row(status: string, surplusBps: number | null, creationDate: string) {
  return { status, surplusBps, creationDate };
}

test('aggregates fills, average surplus, best fill and the first fill date', () => {
  const record = aggregateTrackRecord([
    row('fulfilled', 12.5, '2026-08-20T10:00:00.000Z'),
    row('fulfilled', 4.5, '2026-08-18T09:00:00.000Z'),
    row('open', 99, '2026-08-01T00:00:00.000Z'),
    row('cancelled', 80, '2026-07-01T00:00:00.000Z'),
  ]);
  assert.equal(record.fills, 2, 'only fulfilled orders are fills');
  assert.equal(record.avgSurplusBps, 8.5);
  assert.equal(record.bestFillBps, 12.5, 'best is the maximum surplus');
  assert.equal(
    record.firstSeen,
    '2026-08-18T09:00:00.000Z',
    'an unfilled order must not date the record',
  );
});

test('a wallet with orders but no fills reports nulls rather than zeros', () => {
  const record = aggregateTrackRecord([
    row('open', null, '2026-08-20T10:00:00.000Z'),
    row('expired', 3, '2026-08-19T10:00:00.000Z'),
  ]);
  assert.deepEqual(record, {
    fills: 0,
    avgSurplusBps: null,
    bestFillBps: null,
    firstSeen: null,
  });
});

test('a wallet with no orders at all reports nulls', () => {
  assert.deepEqual(aggregateTrackRecord([]), {
    fills: 0,
    avgSurplusBps: null,
    bestFillBps: null,
    firstSeen: null,
  });
});

test('a fill whose surplus is not computable still counts and still dates the record', () => {
  const record = aggregateTrackRecord([
    row('fulfilled', null, '2026-08-10T00:00:00.000Z'),
    row('fulfilled', 6, '2026-08-12T00:00:00.000Z'),
  ]);
  assert.equal(record.fills, 2);
  assert.equal(record.avgSurplusBps, 6, 'the averaged set is the fills that priced');
  assert.equal(record.bestFillBps, 6);
  assert.equal(record.firstSeen, '2026-08-10T00:00:00.000Z');
});

test('best fill stays the maximum when every fill came in under the limit', () => {
  const record = aggregateTrackRecord([
    row('fulfilled', -8, '2026-08-10T00:00:00.000Z'),
    row('fulfilled', -2, '2026-08-11T00:00:00.000Z'),
  ]);
  assert.equal(record.avgSurplusBps, -5);
  assert.equal(record.bestFillBps, -2);
});

test('an unparseable creation date is skipped rather than dating the record', () => {
  const record = aggregateTrackRecord([
    row('fulfilled', 2, 'not-a-date'),
    row('fulfilled', 4, '2026-08-15T00:00:00.000Z'),
  ]);
  assert.equal(record.fills, 2);
  assert.equal(record.firstSeen, '2026-08-15T00:00:00.000Z');
});
