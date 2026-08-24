import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildManifest, MANIFEST_SLUGS } from '../src/lib/manifests';

test('every registered agent has a manifest', () => {
  assert.deepEqual([...MANIFEST_SLUGS].sort(), ['grid', 'health-factor', 'lp-range', 'yield']);
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
