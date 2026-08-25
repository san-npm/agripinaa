import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bestAndFirstFill } from '../src/lib/exec';

/** The three fields of an execution row the helper actually reads. */
function row(status: string, surplusBps: number | null, creationDate: string) {
  return { status, surplusBps, creationDate };
}

test('best fill is the maximum surplus and first seen is the earliest fill', () => {
  const span = bestAndFirstFill([
    row('fulfilled', 12.5, '2026-08-20T10:00:00.000Z'),
    row('fulfilled', 4.5, '2026-08-18T09:00:00.000Z'),
    row('fulfilled', 9, '2026-08-24T09:00:00.000Z'),
  ]);
  assert.deepEqual(span, {
    bestFillBps: 12.5,
    firstSeen: '2026-08-18T09:00:00.000Z',
  });
});

test('an order that never filled sets neither the best fill nor the start date', () => {
  const span = bestAndFirstFill([
    row('open', 99, '2026-07-01T00:00:00.000Z'),
    row('cancelled', 80, '2026-07-02T00:00:00.000Z'),
    row('expired', 60, '2026-07-03T00:00:00.000Z'),
    row('fulfilled', 5, '2026-08-18T09:00:00.000Z'),
  ]);
  assert.deepEqual(span, {
    bestFillBps: 5,
    firstSeen: '2026-08-18T09:00:00.000Z',
  });
});

test('a wallet with orders but no fills reports nulls rather than zeros', () => {
  assert.deepEqual(
    bestAndFirstFill([
      row('open', null, '2026-08-20T10:00:00.000Z'),
      row('expired', 3, '2026-08-19T10:00:00.000Z'),
    ]),
    { bestFillBps: null, firstSeen: null },
  );
});

test('a wallet with no orders at all reports nulls', () => {
  assert.deepEqual(bestAndFirstFill([]), { bestFillBps: null, firstSeen: null });
});

test('a fill whose surplus is not computable still dates the record', () => {
  const span = bestAndFirstFill([
    row('fulfilled', null, '2026-08-10T00:00:00.000Z'),
    row('fulfilled', 6, '2026-08-12T00:00:00.000Z'),
  ]);
  assert.deepEqual(span, {
    bestFillBps: 6,
    firstSeen: '2026-08-10T00:00:00.000Z',
  });
});

test('best fill stays the maximum when every fill came in under the limit', () => {
  const span = bestAndFirstFill([
    row('fulfilled', -8, '2026-08-10T00:00:00.000Z'),
    row('fulfilled', -2, '2026-08-11T00:00:00.000Z'),
  ]);
  assert.equal(span.bestFillBps, -2);
});

test('an unparseable creation date is skipped rather than dating the record', () => {
  const span = bestAndFirstFill([
    row('fulfilled', 2, 'not-a-date'),
    row('fulfilled', 4, '2026-08-15T00:00:00.000Z'),
  ]);
  assert.equal(span.firstSeen, '2026-08-15T00:00:00.000Z');
});
