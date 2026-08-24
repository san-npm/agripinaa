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

/**
 * Regressions for gaps in the hand-rolled host list this validator replaced.
 * Each of these was accepted before host policy moved to the shared SSRF guard.
 */
test('rejects loopback beyond the one familiar literal', () => {
  assert.equal(isSafeRunnerUrl('https://127.0.0.2'), false);
  assert.equal(isSafeRunnerUrl('https://127.1.2.3'), false);
  // Node normalizes octal in the URL parser, so this arrives as 127.0.0.1.
  assert.equal(isSafeRunnerUrl('https://0177.0.0.1'), false);
});

test('rejects the whole link-local range, not just the metadata address', () => {
  assert.equal(isSafeRunnerUrl('https://169.254.1.1'), false);
  assert.equal(isSafeRunnerUrl('https://169.254.169.254'), false);
});

test('rejects bracketed ipv6 loopback, ula, and link-local', () => {
  // new URL keeps the brackets in hostname, so a bare '::1' string never matched.
  assert.equal(isSafeRunnerUrl('https://[::1]'), false);
  assert.equal(isSafeRunnerUrl('https://[fc00::1]'), false);
  assert.equal(isSafeRunnerUrl('https://[fe80::1]'), false);
});

test('rejects other private and carrier ranges', () => {
  assert.equal(isSafeRunnerUrl('https://10.0.0.1'), false);
  assert.equal(isSafeRunnerUrl('https://192.168.1.1'), false);
  assert.equal(isSafeRunnerUrl('https://172.16.0.1'), false);
  assert.equal(isSafeRunnerUrl('https://100.64.0.1'), false);
  assert.equal(isSafeRunnerUrl('https://0.0.0.0'), false);
});

test('rejects userinfo, which reads as one host and parses as another', () => {
  assert.equal(isSafeRunnerUrl('https://agents.example.com@169.254.169.254/'), false);
  assert.equal(isSafeRunnerUrl('https://user:pass@example.com/'), false);
});

test('rejects an ipfs url that the shared guard would rewrite to https', () => {
  assert.equal(isSafeRunnerUrl('ipfs://QmSomeCidValueHere'), false);
});
