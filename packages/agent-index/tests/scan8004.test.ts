import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The upstream calls carry their own deadline. Set before the module loads,
 * because it reads its configuration once at import.
 */
process.env.SCAN8004_API_KEY = 'not-a-real-key';
process.env.SCAN8004_KEYED_BASE = 'https://upstream.test/api/v1';
process.env.SCAN8004_TIMEOUT_MS = '30';

const { Scan8004Source } = await import('../src/sources/scan8004');

test('an upstream that takes the request and never answers is given up on', { timeout: 5_000 }, async () => {
  const realFetch = globalThis.fetch;
  let signalled = false;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    signalled = init?.signal instanceof AbortSignal;
    // A socket that connects and then goes quiet: only the caller's own
    // deadline ends this.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as typeof fetch;

  try {
    await assert.rejects(() => new Scan8004Source().listAgents({ chainId: 56, limit: 10 }));
    assert.ok(signalled, 'the request went out without a deadline attached');
  } finally {
    globalThis.fetch = realFetch;
  }
});
