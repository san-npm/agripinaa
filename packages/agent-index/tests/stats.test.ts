import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chainScopedTotal } from '../src/sources/scan8004';

test('prefers the keyed per-chain total', () => {
  assert.equal(chainScopedTotal({ keyedTotal: 257873, publicTotal: 765100 }), 257873);
});

test('falls back to the public total when unkeyed', () => {
  assert.equal(chainScopedTotal({ keyedTotal: null, publicTotal: 765100 }), 765100);
});

test('returns null when neither is available', () => {
  assert.equal(chainScopedTotal({ keyedTotal: null, publicTotal: null }), null);
});
