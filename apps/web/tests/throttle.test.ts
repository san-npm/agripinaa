import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAIN_READ_GLOBAL_KEY,
  CHAIN_READ_LIMIT_GLOBAL,
  CHAIN_READ_LIMIT_PER_CLIENT,
  CHAIN_READ_WINDOW_MS,
  UNATTRIBUTED_CLIENT,
  chainReadKey,
  clientKey,
  takeChainRead,
  type ThrottleKv,
} from '../src/lib/throttle';

/**
 * The counter that stands in front of the site's unauthenticated chain reads.
 * Everything here runs against an in-memory store, so the limits are asserted
 * without a KV and without a clock.
 */

interface TestKv extends ThrottleKv {
  store: Map<string, string>;
  reads: number;
  writes: number;
}

function storedCount(raw: string | undefined, window: number): number {
  try {
    const parsed = JSON.parse(raw ?? '') as { w?: unknown; n?: unknown };
    return parsed.w === window && typeof parsed.n === 'number' ? parsed.n : 0;
  } catch {
    return 0;
  }
}

function memoryKv(opts: { available?: boolean; throwing?: boolean } = {}): TestKv {
  const kv: TestKv = {
    store: new Map<string, string>(),
    reads: 0,
    writes: 0,
    available: () => opts.available ?? true,
    reserveCounterPair: async (input) => {
      kv.reads += 1;
      if (opts.throwing) throw new Error('kv unreachable');
      const mine = storedCount(kv.store.get(input.clientKey), input.window);
      const all = storedCount(kv.store.get(input.globalKey), input.window);
      if (mine >= input.perClientLimit || all >= input.globalLimit) return false;
      kv.store.set(input.clientKey, JSON.stringify({ w: input.window, n: mine + 1 }));
      kv.store.set(input.globalKey, JSON.stringify({ w: input.window, n: all + 1 }));
      kv.writes += 2;
      return true;
    },
  };
  return kv;
}

const NOW = Date.parse('2026-08-25T09:00:00.000Z');

const take = (kv: ThrottleKv, client = 'client-a', now = NOW) =>
  takeChainRead({ client, kv, now: () => now });

test('the first request from a client is allowed and counted', async () => {
  const kv = memoryKv();
  assert.equal(await take(kv), true);
  assert.equal(kv.reads, 1, 'one batched read covers both buckets');
  assert.equal(kv.store.size, 2, 'the client bucket and the global one');
  assert.ok(kv.store.get(chainReadKey('client-a')), 'the client bucket was written');
});

test('a client past its limit is refused before anything reaches the chain', async () => {
  const kv = memoryKv();
  for (let i = 0; i < CHAIN_READ_LIMIT_PER_CLIENT; i++) {
    assert.equal(await take(kv), true, `request ${i + 1} is inside the limit`);
  }
  assert.equal(await take(kv), false, 'the request past the limit is refused');
  // A refusal costs the read that discovered it and no write.
  const writes = kv.writes;
  assert.equal(await take(kv), false);
  assert.equal(kv.writes, writes, 'a refused request writes nothing');
});

test('another client keeps its own budget while one is throttled', async () => {
  const kv = memoryKv();
  for (let i = 0; i < CHAIN_READ_LIMIT_PER_CLIENT; i++) await take(kv);
  assert.equal(await take(kv), false);
  assert.equal(await take(kv, 'client-b'), true);
});

test('the next window lets a throttled client through again', async () => {
  const kv = memoryKv();
  for (let i = 0; i < CHAIN_READ_LIMIT_PER_CLIENT; i++) await take(kv);
  assert.equal(await take(kv), false);
  assert.equal(await take(kv, 'client-a', NOW + CHAIN_READ_WINDOW_MS), true);
});

test('the global budget holds when a flood arrives from many addresses', async () => {
  // The per-client bucket is keyed on a header a caller sets, so it alone would
  // be walked past by varying it. The global bucket is what actually caps the
  // rpc spend, and it is the reason both are checked.
  const kv = memoryKv();
  kv.store.set(
    CHAIN_READ_GLOBAL_KEY,
    JSON.stringify({ w: Math.floor(NOW / CHAIN_READ_WINDOW_MS), n: CHAIN_READ_LIMIT_GLOBAL }),
  );
  assert.equal(await take(kv, 'a-fresh-address'), false);
});

test('a parallel flood reserves exactly the global budget, not one shared overwrite', async () => {
  const kv = memoryKv();
  const allowed = await Promise.all(
    Array.from({ length: CHAIN_READ_LIMIT_GLOBAL + 100 }, (_, i) => take(kv, `client-${i}`)),
  );
  assert.equal(allowed.filter(Boolean).length, CHAIN_READ_LIMIT_GLOBAL);
  assert.equal(allowed.filter((value) => !value).length, 100);
  assert.equal(
    storedCount(kv.store.get(CHAIN_READ_GLOBAL_KEY), Math.floor(NOW / CHAIN_READ_WINDOW_MS)),
    CHAIN_READ_LIMIT_GLOBAL,
  );
});

test('without a store an unavailable reservation is distinct from a spent budget', async () => {
  const kv = memoryKv({ available: false });
  for (let i = 0; i < CHAIN_READ_LIMIT_PER_CLIENT + 5; i++) {
    assert.equal(await take(kv), null);
  }
  assert.equal(kv.reads, 0, 'an unconfigured store is never asked');
});

test('a configured store that cannot reserve a slot fails closed', async () => {
  const kv = memoryKv({ throwing: true });
  assert.equal(await take(kv), null);
});

test('a stored bucket that is not a counter is read as an empty one', async () => {
  const kv = memoryKv();
  kv.store.set(chainReadKey('client-a'), 'not json');
  assert.equal(await take(kv), true);
  kv.store.set(chainReadKey('client-a'), JSON.stringify({ w: 'whenever', n: 9_000 }));
  assert.equal(await take(kv), true);
});

test('the client key is the first forwarded hop, and junk falls back to one bucket', async () => {
  const header = (value: string | null) => ({ get: () => value });
  assert.equal(clientKey(header('203.0.113.7, 70.41.3.18')), '203.0.113.7');
  assert.equal(clientKey(header('  2001:db8::1  ')), '2001:db8::1');
  assert.equal(clientKey(header(null)), UNATTRIBUTED_CLIENT);
  assert.equal(clientKey(header('')), UNATTRIBUTED_CLIENT);
  assert.equal(clientKey(header('not an address')), UNATTRIBUTED_CLIENT);
  // A header cannot grow a key without bound, nor carry a kv key separator.
  assert.equal(clientKey(header('9'.repeat(200))), UNATTRIBUTED_CLIENT);
  assert.equal(clientKey(header('203.0.113.7/../x')), UNATTRIBUTED_CLIENT);
});
