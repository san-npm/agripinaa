import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearSessionGrantCheckpoint,
  loadSessionGrantCheckpoint,
  resetRotatedManagerCheckpoint,
  retireExpiredRotatedManagerCheckpoint,
  rotatedManagerCheckpoint,
  reserveSessionGrantCheckpoint,
  restoreRetiredManagerGrantCheckpoint,
  saveRotatedManagerRevocationCheckpoint,
  submitSessionGrantCheckpoint,
} from '../src/lib/session-grant-checkpoint';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const PUBLIC_KEY = `0x04${'22'.repeat(64)}` as const;
const OTHER_KEY = `0x04${'33'.repeat(64)}` as const;
const CALLS_ID = `0x${'44'.repeat(32)}` as const;
const REVOKE_CALLS_ID = `0x${'55'.repeat(32)}` as const;

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

async function withLockedStorage(run: (values: Map<string, string>) => Promise<void>): Promise<void> {
  const values = new Map<string, string>();
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let tail = Promise.resolve();
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
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
          const request = tail.then(callback);
          tail = request.catch(() => {});
          return request;
        },
      },
    },
  });
  try {
    await run(values);
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
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

test('a clean browser restores the pinned retired grant exactly once', async () => {
  await withLockedStorage(async () => {
    const restored = await restoreRetiredManagerGrantCheckpoint(56, ACCOUNT, 'yield-b', {
      publicKey: PUBLIC_KEY,
      expiry: 1_900_000_000,
      grantCallsId: CALLS_ID,
    });
    assert.equal(restored.status, 'submitted');
    if (restored.status !== 'submitted') assert.fail('checkpoint was not submitted');
    assert.equal(restored.callsId, CALLS_ID);

    const again = await restoreRetiredManagerGrantCheckpoint(56, ACCOUNT, 'yield-b', {
      publicKey: OTHER_KEY,
      expiry: 1_900_000_001,
      grantCallsId: REVOKE_CALLS_ID,
    });
    assert.deepEqual(again, restored, 'an existing checkpoint must not be overwritten');
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

test('a rotated manager cannot retire a checkpoint while the previous grant could become live', async () => {
  await withLockedStorage(async () => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000);
    await assert.rejects(
      retireExpiredRotatedManagerCheckpoint(
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

test('an expired checkpoint is retired only after the pinned manager rotates', async () => {
  await withLockedStorage(async () => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'lp-range', PUBLIC_KEY, 1_900_000_000);
    assert.equal(
      (await retireExpiredRotatedManagerCheckpoint(
        56,
        ACCOUNT,
        'lp-range',
        PUBLIC_KEY,
        1_900_000_001,
      ))?.publicKey,
      PUBLIC_KEY,
    );
    assert.equal(
      await retireExpiredRotatedManagerCheckpoint(
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

test('an explicit reset retires only the exact previous manager checkpoint', async () => {
  await withLockedStorage(async () => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'yield-b', PUBLIC_KEY, 1_900_000_000);
    assert.equal(
      rotatedManagerCheckpoint(56, ACCOUNT, 'yield-b', OTHER_KEY)?.publicKey,
      PUBLIC_KEY,
    );
    assert.equal(rotatedManagerCheckpoint(56, ACCOUNT, 'yield-b', PUBLIC_KEY), null);

    await assert.rejects(
      resetRotatedManagerCheckpoint(
        56,
        ACCOUNT,
        'yield-b',
        { ...loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b')!, publicKey: OTHER_KEY },
        OTHER_KEY,
      ),
      /changed before it could be reset/,
    );
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b')?.publicKey, PUBLIC_KEY);

    const checkpoint = loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b')!;
    await resetRotatedManagerCheckpoint(56, ACCOUNT, 'yield-b', checkpoint, OTHER_KEY);
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b'), null);
  });
});

test('a stale tab cannot retire a newer checkpoint for the same manager', async () => {
  await withLockedStorage(async () => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'yield-b', PUBLIC_KEY, 1_900_000_000);
    const stale = loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b')!;
    clearSessionGrantCheckpoint(56, ACCOUNT, 'yield-b');
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'yield-b', PUBLIC_KEY, 1_900_000_001);

    await assert.rejects(
      resetRotatedManagerCheckpoint(56, ACCOUNT, 'yield-b', stale, OTHER_KEY),
      /changed before it could be reset/,
    );
    assert.equal(loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b')?.expiry, 1_900_000_001);
  });
});

test('a pending old-key revocation replaces the exact grant checkpoint', () => {
  withStorage(() => {
    reserveSessionGrantCheckpoint(56, ACCOUNT, 'yield-b', PUBLIC_KEY, 1_900_000_000);
    submitSessionGrantCheckpoint(56, ACCOUNT, 'yield-b', PUBLIC_KEY, 1_900_000_000, CALLS_ID);
    const grant = loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b')!;

    const revoking = saveRotatedManagerRevocationCheckpoint(
      56,
      ACCOUNT,
      'yield-b',
      grant,
      OTHER_KEY,
      REVOKE_CALLS_ID,
    );
    assert.deepEqual(loadSessionGrantCheckpoint(56, ACCOUNT, 'yield-b'), revoking);
    assert.equal(revoking.status, 'revoking');
    if (revoking.status !== 'revoking') assert.fail('revocation checkpoint missing');
    assert.equal(revoking.callsId, REVOKE_CALLS_ID);

    assert.throws(
      () => saveRotatedManagerRevocationCheckpoint(
        56,
        ACCOUNT,
        'yield-b',
        grant,
        OTHER_KEY,
        CALLS_ID,
      ),
      /changed before its revocation could be tracked/,
    );
  });
});
