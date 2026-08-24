import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildManifest, MANIFEST_SLUGS } from '../src/lib/manifests';

test('every agent in the registry has a manifest, registered or not', () => {
  // An agent needs its manifest served BEFORE it can be registered: register.ts
  // preflights the URL, and the tokenURI it mints is permanent.
  assert.deepEqual(
    [...MANIFEST_SLUGS].sort(),
    ['grid', 'grid-b', 'health-factor', 'lp-range', 'weight-rebalancer', 'yield'],
  );
});

test('an unregistered agent is served with its own body, not a placeholder', () => {
  const m = buildManifest('grid-b', 'https://runner.example.com');
  assert.equal(m?.name, 'Agripinaa Grid B');
  assert.equal(m?.category, 'grid');
  assert.equal(m?.execution.pair, 'WBNB/USDC');
  assert.equal(m?.x402.endpoint, 'https://runner.example.com/grid-b/status');
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
