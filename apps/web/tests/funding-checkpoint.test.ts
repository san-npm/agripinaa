import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Address, Hex } from 'viem';

import {
  assertFundingCheckpointWritable,
  clearFundingCheckpoint,
  clearFundingCheckpointForSession,
  listFundingCheckpoints,
  loadFundingCheckpoint,
  saveFundingCheckpoint,
  shouldPauseAfterFundingConfirmation,
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
        get length() {
          return values.size;
        },
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
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
  it('pauses after a new confirmation but continues from an existing one', () => {
    const submitted = { status: 'submitted', callsId: CALLS_ID, plan: PLAN } as const;
    const confirmed = {
      ...submitted,
      status: 'confirmed',
      transactionHash: HASH,
      receiptBlockNumber: 123n,
    } as const;

    assert.equal(shouldPauseAfterFundingConfirmation(null), true);
    assert.equal(shouldPauseAfterFundingConfirmation(submitted), true);
    assert.equal(shouldPauseAfterFundingConfirmation(confirmed), false);
    assert.equal(shouldPauseAfterFundingConfirmation(null, true), false);
  });

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
      assert.equal(typeof restored?.savedAt, 'number');
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

  it('enumerates valid unfinished activations for dashboard recovery', () => {
    withLocalStorage((values) => {
      saveFundingCheckpoint(56, ACCOUNT, 'lp-range', {
        status: 'submitted',
        callsId: CALLS_ID,
        plan: PLAN,
      });
      saveFundingCheckpoint(56, ACCOUNT, 'grid', {
        status: 'confirmed',
        callsId: CALLS_ID,
        transactionHash: HASH,
        receiptBlockNumber: 123n,
        plan: PLAN,
      });
      values.set('unrelated', '{bad json');

      const activations = listFundingCheckpoints();
      assert.deepEqual(
        activations.map(({ chainId, account, agent, checkpoint }) => ({
          chainId,
          account,
          agent,
          status: checkpoint.status,
        })),
        [
          { chainId: 56, account: ACCOUNT, agent: 'lp-range', status: 'submitted' },
          { chainId: 56, account: ACCOUNT, agent: 'grid', status: 'confirmed' },
        ],
      );
      assert.equal(values.has('unrelated'), true);
    });
  });

  it('omits reservations and corrupt records without mutating concurrent recovery state', () => {
    withLocalStorage((values) => {
      saveFundingCheckpoint(56, ACCOUNT, 'lp-range', {
        status: 'submitted',
        callsId: CALLS_ID,
        plan: PLAN,
      });
      values.set('agripinaa.funding-bootstrap.v3:nope:not-an-address:grid', '{}');
      values.set(`agripinaa.funding-bootstrap.v3:56:${ACCOUNT}:grid`, '{bad json');
      assertFundingCheckpointWritable(56, ACCOUNT, 'grid-b', PLAN);

      assert.deepEqual(listFundingCheckpoints().map((entry) => entry.agent), ['lp-range']);
      assert.equal(values.size, 4);
      assert.match(
        values.get(`agripinaa.funding-bootstrap.v3:56:${ACCOUNT}:grid-b`) ?? '',
        /"status":"reserved"/,
      );
    });
  });

  it('preserves the first submission timestamp when confirmation replaces it', () => {
    withLocalStorage(() => {
      saveFundingCheckpoint(56, ACCOUNT, 'lp-range', {
        status: 'submitted',
        callsId: CALLS_ID,
        plan: PLAN,
      });
      const submittedAt = loadFundingCheckpoint(56, ACCOUNT, 'lp-range')?.savedAt;
      saveFundingCheckpoint(56, ACCOUNT, 'lp-range', {
        status: 'confirmed',
        callsId: CALLS_ID,
        transactionHash: HASH,
        receiptBlockNumber: 123n,
        plan: PLAN,
      });

      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'lp-range')?.savedAt, submittedAt);
    });
  });

  it('clears only a checkpoint that predates the session being handed off', () => {
    withLocalStorage(() => {
      saveFundingCheckpoint(56, ACCOUNT, 'grid', {
        status: 'submitted',
        callsId: CALLS_ID,
        plan: PLAN,
        savedAt: 2_000,
      });

      clearFundingCheckpointForSession(
        56,
        ACCOUNT,
        'grid',
        new Date(1_000).toISOString(),
      );
      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid')?.callsId, CALLS_ID);

      clearFundingCheckpointForSession(
        56,
        ACCOUNT,
        'grid',
        new Date(3_000).toISOString(),
      );
      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid'), null);
    });
  });

  it('retains legacy checkpoints when session correlation is unavailable', () => {
    withLocalStorage((values) => {
      saveFundingCheckpoint(56, ACCOUNT, 'grid', {
        status: 'submitted',
        callsId: CALLS_ID,
        plan: PLAN,
      });
      const storageKey = `agripinaa.funding-bootstrap.v3:56:${ACCOUNT}:grid`;
      const stored = JSON.parse(values.get(storageKey) ?? '{}') as Record<string, unknown>;
      delete stored.savedAt;
      values.set(storageKey, JSON.stringify(stored));

      clearFundingCheckpointForSession(
        56,
        ACCOUNT,
        'grid',
        new Date(3_000).toISOString(),
      );
      assert.equal(loadFundingCheckpoint(56, ACCOUNT, 'grid')?.callsId, CALLS_ID);
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
