import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildManifest, MANIFEST_SLUGS } from '../src/lib/manifests';

test('every agent in the registry has a manifest, registered or not', () => {
  // An agent needs its manifest served BEFORE it can be registered: register.ts
  // preflights the URL, and the tokenURI it mints is permanent.
  assert.deepEqual(
    [...MANIFEST_SLUGS].sort(),
    [
      'grid',
      'grid-b',
      'health-factor',
      'lp-range',
      'venus-guardian',
      'weight-rebalancer',
      'yield',
      'yield-b',
    ],
  );
});

test('the second registered grid is served with its own body, not a placeholder', () => {
  const m = buildManifest('grid-b', 'https://runner.example.com');
  assert.equal(m?.name, 'Agripinaa BTC Grid');
  assert.equal(m?.category, 'grid');
  // The served pair is BTCB/USDT, not a second dollar quote on grid's WBNB: the
  // manifest is what a judge reads to tell the two grid agents apart.
  assert.equal(m?.execution.pair, 'BTCB/USDT');
  assert.equal(m?.x402.endpoint, 'https://runner.example.com/grid-b/status');
  assert.equal(m?.x402.note, 'live');
});

test('every registered manifest is served as live', () => {
  for (const slug of MANIFEST_SLUGS) {
    assert.equal(buildManifest(slug, 'https://runner.example.com')?.x402.note, 'live', slug);
  }
});

test('injects the runner base into the x402 endpoint', () => {
  const m = buildManifest('grid', 'https://runner.example.com');
  assert.equal(m?.x402.endpoint, 'https://runner.example.com/grid/status');
  assert.equal(m?.category, 'grid');
  assert.equal(m?.name, 'Agripinaa Grid');
});

test('unknown slug returns null', () => {
  assert.equal(buildManifest('nope', 'https://runner.example.com'), null);
});
