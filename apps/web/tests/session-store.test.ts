import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listStoredSessions, storeSession } from '../src/lib/session-store';

function withStorage(run: () => void): void {
  const values = new Map<string, string>();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
  try {
    run();
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

const session = {
  walletAddress: '0x1111111111111111111111111111111111111111',
  publicKey: `0x04${'22'.repeat(64)}`,
  permissions: { calls: [], spend: [] },
  expiry: 1_900_000_000,
};

test('recovery refreshes one pending record instead of duplicating its key', () => {
  withStorage(() => {
    const first = storeSession({
      session,
      chainId: 56,
      agent: { chainId: 56, tokenId: '1', name: 'Ranger', slug: 'lp-range' },
      scope: { allowlist: [], capFormatted: 'old', expiresAt: '2030-01-01T00:00:00.000Z' },
      principalUsdt: '100',
    });
    const recovered = storeSession({
      session,
      chainId: 56,
      agent: { chainId: 56, tokenId: '1', name: 'Ranger', slug: 'lp-range' },
      scope: { allowlist: [], capFormatted: 'recovered', expiresAt: '2030-03-17T17:46:40.000Z' },
      principalUsdt: '125',
    });

    assert.equal(recovered.id, first.id);
    assert.equal(recovered.grantedAt, first.grantedAt);
    assert.ok(recovered.correlatedAt);
    assert.equal(listStoredSessions()[0]?.correlatedAt, recovered.correlatedAt);
    assert.equal(recovered.principalUsdt, first.principalUsdt);
    assert.equal(recovered.scope.capFormatted, 'recovered');
    assert.equal(listStoredSessions().length, 1);
  });
});
