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
