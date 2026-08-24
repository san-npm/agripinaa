import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSafeRunnerUrl } from '../src/lib/runner-url';

test('accepts https origins', () => {
  assert.equal(isSafeRunnerUrl('https://example.trycloudflare.com'), true);
  assert.equal(isSafeRunnerUrl('https://agents.example.ts.net/'), true);
});

test('rejects non-https, malformed, and internal targets', () => {
  assert.equal(isSafeRunnerUrl('http://example.com'), false);
  assert.equal(isSafeRunnerUrl('not a url'), false);
  assert.equal(isSafeRunnerUrl('https://localhost:4410'), false);
  assert.equal(isSafeRunnerUrl('https://127.0.0.1'), false);
  assert.equal(isSafeRunnerUrl('https://169.254.169.254'), false);
  assert.equal(isSafeRunnerUrl(''), false);
  assert.equal(isSafeRunnerUrl(null), false);
});

test('rejects a url longer than 300 chars', () => {
  assert.equal(isSafeRunnerUrl(`https://a.example.com/${'x'.repeat(300)}`), false);
});
