import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Address, Hex } from 'viem';

import {
  assertFundingCheckpointWritable,
  clearFundingCheckpoint,
  loadFundingCheckpoint,
  saveFundingCheckpoint,
} from '../src/lib/funding-checkpoint';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const CALLS_ID = `0x${'cd'.repeat(32)}` as Hex;

function withLocalStorage(
  run: (values: Map<string, string>) => void,
  maxChars = Number.POSITIVE_INFINITY,
): void {
  const values = new Map<string, string>();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          const currentSize = [...values.entries()].reduce(
            (total, [storedKey, storedValue]) => total + storedKey.length + storedValue.length,
            0,
          );
          const old = values.get(key);
          const nextSize = currentSize
            - (old === undefined ? 0 : key.length + old.length)
            + key.length
            + value.length;
          if (nextSize > maxChars) throw new Error('QuotaExceededError');
          values.set(key, value);
        },
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

const PLAN = {
  calls: [],
  preCalls: [],
  input: 'BNB' as const,
  grossInput: 5n,
  gasReserveInput: 1n,
  bootstrapFeeInput: 1n,
  nativeReserveOutputWei: 0n,
  strategyInput: 3n,
  targets: ['WBNB'] as const,
  estimatedOutputs: { WBNB: 3n },
  minimumOutputs: { WBNB: 3n },
};

describe('funding bootstrap checkpoint', () => {
  it('round-trips bigint plan data but never restores executable calls', () => {
    withLocalStorage(() => {
      saveFundingCheckpoint(56, ACCOUNT, 'grid', {
        status: 'confirmed',
        callsId: CALLS_ID,
        transactionHash: HASH,
        expectedTotalWei: 98n,
        receiptBlockNumber: 123n,
        plan: {
          calls: [{ to: ACCOUNT, value: 10n }],
          preCalls: [{ to: ACCOUNT, value: 1n }],
          input: 'USDT',
          grossInput: 100n,
          gasReserveInput: 1n,
          bootstrapFeeInput: 1n,
          nativeReserveOutputWei: 7n,
          strategyInput: 98n,
          targets: ['WBNB', 'USDT'],
          estimatedOutputs: { WBNB: 49n, USDT: 49n },
          minimumOutputs: { WBNB: 48n, USDT: 48n },
          merchantUrl: 'https://example.test/merchant',
        },
      });

      const restored = loadFundingCheckpoint(56, ACCOUNT, 'grid');
      assert.equal(restored?.status, 'confirmed');
      assert.ok(restored && restored.status === 'confirmed');
      assert.equal(restored.transactionHash, HASH);
      assert.equal(restored.callsId, CALLS_ID);
      assert.equal(restored?.expectedTotalWei, 98n);
      assert.equal(restored.receiptBlockNumber, 123n);
      assert.equal(restored?.plan.strategyInput, 98n);
      assert.equal(restored?.plan.nativeReserveOutputWei, 7n);
      assert.deepEqual(restored?.plan.targets, ['WBNB', 'USDT']);
      assert.deepEqual(restored?.plan.calls, []);
      assert.deepEqual(restored?.plan.preCalls, []);
      assert.equal(restored?.plan.merchantUrl, undefined);
    });
  });

  it('persists a relay submission before a receipt exists, scoped to account and agent', () => {
    withLocalStorage(() => {
      saveFundingCheckpoint(56, ACCOUNT, 'grid', {
        status: 'submitted',
        callsId: CALLS_ID,
        plan: PLAN,
      });

      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid-b'), null);
      assert.equal(loadFundingCheckpoint(
        56,
        '0x2222222222222222222222222222222222222222',
        'grid',
      ), null);
      const restored = loadFundingCheckpoint(56, ACCOUNT, 'grid');
      assert.equal(restored?.status, 'submitted');
      assert.equal(restored?.callsId, CALLS_ID);
      clearFundingCheckpoint(56, ACCOUNT, 'grid');
      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid'), null);
    });
  });

  it('reserves a full-size checkpoint before submission and atomically replaces it', () => {
    withLocalStorage((values) => {
      assertFundingCheckpointWritable(56, ACCOUNT, 'grid', PLAN, 9n);
      const reserved = [...values.values()][0];
      assert.match(reserved ?? '', /"status":"reserved"/);
      assert.ok((reserved?.length ?? 0) > 4_096);

      saveFundingCheckpoint(56, ACCOUNT, 'grid', {
        status: 'submitted',
        callsId: CALLS_ID,
        expectedTotalWei: 9n,
        plan: PLAN,
      });
      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid')?.callsId, CALLS_ID);
    }, 5_500);
  });

  it('rejects near-full storage before a relay id can exist', () => {
    withLocalStorage(() => {
      assert.throws(
        () => assertFundingCheckpointWritable(56, ACCOUNT, 'grid', PLAN),
        /QuotaExceededError/,
      );
    }, 1_000);
  });

  it('discards an interrupted reservation because no relay call was submitted', () => {
    withLocalStorage((values) => {
      assertFundingCheckpointWritable(56, ACCOUNT, 'grid', PLAN);
      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid'), null);
      assert.equal(values.size, 0);
    });
  });
});
