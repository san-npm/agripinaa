import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearSessionGrantCheckpoint,
  loadSessionGrantCheckpoint,
  retireExpiredRotatedManagerCheckpoint,
  reserveSessionGrantCheckpoint,
  submitSessionGrantCheckpoint,
} from '../src/lib/session-grant-checkpoint';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const PUBLIC_KEY = `0x04${'22'.repeat(64)}` as const;
const OTHER_KEY = `0x04${'33'.repeat(64)}` as const;
const CALLS_ID = `0x${'44'.repeat(32)}` as const;

function withStorage(run: (values: Map<string, string>) => void): void {
  const values = new Map<string, string>();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  try {
    run(values);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('reserves before relay submission and replaces the reservation with its call id', () => {
  withStorage((values) => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000);
    const reserved = loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range');
    assert.equal(reserved?.status, 'reserved');
    assert.ok([...values.values()][0]!.length > 4_096);

    submitSessionGrantCheckpoint(
      56,
      ACCOUNT,
      'lp-range',
      PUBLIC_KEY,
      1_900_000_000,
      CALLS_ID,
    );
    const submitted = loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range');
    assert.equal(submitted?.status, 'submitted');
    if (submitted?.status !== 'submitted' || reserved === null) assert.fail('checkpoint missing');
    assert.equal(submitted.callsId, CALLS_ID);
    assert.equal(submitted.savedAt, reserved.savedAt);

    clearSessionGrantCheckpoint(56, ACCOUNT, 'lp-range');
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range'), null);
  });
});

test('never replaces a reservation for another manager identity', () => {
  withStorage(() => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000);
    assert.throws(
      () => reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000),
      /already reserved/,
    );
    assert.throws(
      () => submitSessionGrantCheckpoint(
        56,
        ACCOUNT,
        'lp-range',
        OTHER_KEY,
        1_900_000_000,
        CALLS_ID,
      ),
      /reservation changed/,
    );
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range')?.status, 'reserved');
  });
});

test('corrupt grant state fails closed instead of reopening registration', () => {
  withStorage((values) => {
    values.set(
      `agripinaa.session-grant.v1:56:${ACCOUNT}:lp-range`,
      '{"version":1,"status":"submitted"}',
    );
    assert.throws(
      () => loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range'),
      /unreadable/,
    );
    assert.equal(values.size, 1);
  });
});

test('a rotated manager cannot retire a checkpoint while the previous grant could become live', () => {
  withStorage(() => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000);
    assert.throws(
      () => retireExpiredRotatedManagerCheckpoint(
        56,
        ACCOUNT,
        'lp-range',
        OTHER_KEY,
        1_899_999_999,
      ),
      /previous manager key may remain relayable/,
    );
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range')?.publicKey, PUBLIC_KEY);
  });
});

test('an expired checkpoint is retired only after the pinned manager rotates', () => {
  withStorage(() => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000);
    assert.equal(
      retireExpiredRotatedManagerCheckpoint(
        56,
        ACCOUNT,
        'lp-range',
        PUBLIC_KEY,
        1_900_000_001,
      )?.publicKey,
      PUBLIC_KEY,
    );
    assert.equal(
      retireExpiredRotatedManagerCheckpoint(
        56,
        ACCOUNT,
        'lp-range',
        OTHER_KEY,
        1_900_000_001,
      ),
      null,
    );
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'lp-range'), null);
  });
});
