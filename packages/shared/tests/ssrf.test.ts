import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertResolvedHostPublic, assertSafeUrl, BlockedUrlError } from '../src/ssrf';

test('https public host is allowed', () => {
  assert.equal(assertSafeUrl('https://agripinaa.vercel.app/manifests/grid.json').hostname, 'agripinaa.vercel.app');
});

test('ipfs is rewritten to the https gateway', () => {
  assert.equal(assertSafeUrl('ipfs://bafyfoo').hostname, 'ipfs.io');
});

test('non-https schemes are blocked', () => {
  for (const u of ['http://example.com', 'file:///etc/passwd', 'ftp://host/x', 'gopher://x']) {
    assert.throws(() => assertSafeUrl(u), BlockedUrlError, u);
  }
});

/**
 * Regressions for a guard bypass found on 2026-08-24. The WHATWG URL parser
 * rewrites an embedded IPv4 tail into hex, so `[::ffff:127.0.0.1]` arrives as
 * `[::ffff:7f00:1]`; the old `::ffff:` strip left `7f00:1`, which matched no
 * dotted-quad check, and the DNS guard returns early for every colon-bearing
 * literal. Every address below was ACCEPTED before the fix. This guard is what
 * safeFetchJson uses to fetch ERC-8004 tokenURIs, which anyone can register.
 */
test('v4-mapped IPv6 forms of private ranges are blocked', () => {
  for (const h of [
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:169.254.169.254]/latest/meta-data/',
    'https://[::ffff:10.0.0.1]/x',
    'https://[::ffff:192.168.1.1]/x',
    'https://[::ffff:172.16.5.5]/x',
    'https://[::ffff:100.64.0.1]/x',
    // The same addresses in the hex form the URL parser actually produces.
    'https://[::ffff:7f00:1]/x',
    'https://[::ffff:a9fe:a9fe]/x',
    // v4-compatible and NAT64 carry an IPv4 in the low 32 bits too.
    'https://[::169.254.169.254]/x',
    'https://[64:ff9b::169.254.169.254]/x',
  ]) {
    assert.throws(() => assertSafeUrl(h), BlockedUrlError, h);
  }
});

test('the whole fe80::/10 link-local range is blocked, not just fe80:', () => {
  for (const h of ['https://[fe80::1]/x', 'https://[fe90::1]/x', 'https://[fea0::1]/x', 'https://[febf::1]/x']) {
    assert.throws(() => assertSafeUrl(h), BlockedUrlError, h);
  }
});

test('public IPv6 is still allowed', () => {
  assert.equal(assertSafeUrl('https://[2606:4700:4700::1111]/x').hostname, '[2606:4700:4700::1111]');
  assert.equal(assertSafeUrl('https://[::ffff:8.8.8.8]/x').protocol, 'https:');
});

test('cloud metadata and private ranges are blocked', () => {
  for (const h of [
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/x',
    'https://10.0.0.5/admin',
    'https://192.168.1.1/',
    'https://172.16.5.5/',
    'https://100.64.0.1/',
    'https://localhost/x',
    'https://[::1]/x',
    'https://[fd00::1]/x',
  ]) {
    assert.throws(() => assertSafeUrl(h), BlockedUrlError, h);
  }
});

test('a public IP literal is allowed', () => {
  assert.equal(assertSafeUrl('https://8.8.8.8/x').hostname, '8.8.8.8');
});

test('a DNS name resolving to a private address is blocked (rebinding)', async () => {
  const url = assertSafeUrl('https://totally-innocent.example/x');
  await assert.rejects(
    () => assertResolvedHostPublic(url, async () => [{ address: '169.254.169.254' }]),
    BlockedUrlError,
  );
  await assert.rejects(
    () => assertResolvedHostPublic(url, async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]),
    BlockedUrlError,
  );
});

test('a DNS name resolving only to public addresses is allowed', async () => {
  const url = assertSafeUrl('https://public.example/x');
  await assert.doesNotReject(() =>
    assertResolvedHostPublic(url, async () => [{ address: '93.184.216.34' }]),
  );
});
