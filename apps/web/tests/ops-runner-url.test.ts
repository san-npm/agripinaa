import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LookupFn } from '@agripinaa/shared/ssrf';

import { decideRunnerUrlReport } from '../src/lib/ops-runner-url';

const TOKEN = 'test-ops-token';

/** A stub resolver, so no test in this file touches real DNS. */
const resolvesTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address }));

const PUBLIC = resolvesTo('104.16.132.229');

function report(overrides: {
  opsToken?: string | undefined;
  authorization?: string | null;
  body?: unknown;
  readBodyText?: () => Promise<string>;
  lookup?: LookupFn;
}) {
  return decideRunnerUrlReport({
    // `in` rather than `??`, so an explicit undefined/null is honoured instead
    // of falling back to the configured token or a valid bearer.
    opsToken: 'opsToken' in overrides ? overrides.opsToken : TOKEN,
    authorization: 'authorization' in overrides ? overrides.authorization! : `Bearer ${TOKEN}`,
    readBodyText:
      overrides.readBodyText ?? (async () => JSON.stringify(overrides.body ?? {})),
    lookup: overrides.lookup ?? PUBLIC,
  });
}

test('stores a public https url reported with the right bearer', async () => {
  const decision = await report({ body: { url: 'https://runner.example.trycloudflare.com' } });
  assert.deepEqual(decision, { ok: true, url: 'https://runner.example.trycloudflare.com' });
});

test('refuses to authenticate anything when OPS_TOKEN is unset', async () => {
  // Vercel has no OPS_TOKEN today. An absent token must close the endpoint, not
  // open it: every credential, including a blank one, has to fail.
  for (const authorization of [null, 'Bearer ', 'Bearer anything']) {
    const decision = await report({ opsToken: undefined, authorization });
    assert.deepEqual(decision, { ok: false, status: 503, message: 'ops token not configured' });
  }
  const blank = await report({ opsToken: '   ', authorization: 'Bearer    ' });
  assert.equal(blank.ok, false);
  assert.equal(blank.ok === false && blank.status, 503);
});

test('rejects an unauthenticated request', async () => {
  const decision = await report({
    authorization: null,
    body: { url: 'https://runner.example.trycloudflare.com' },
  });
  assert.deepEqual(decision, { ok: false, status: 401, message: 'unauthorized' });
});

test('rejects a wrong, truncated, or wrongly framed bearer', async () => {
  const url = 'https://runner.example.trycloudflare.com';
  for (const authorization of [
    'Bearer wrong-token',
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    TOKEN,
    `bearer ${TOKEN}`,
    `Basic ${TOKEN}`,
  ]) {
    const decision = await report({ authorization, body: { url } });
    assert.equal(decision.ok, false, `accepted ${authorization}`);
    assert.equal(decision.ok === false && decision.status, 401);
  }
});

test('rejects a malformed or unreadable body', async () => {
  const bad = await report({ readBodyText: async () => 'not json at all' });
  assert.deepEqual(bad, { ok: false, status: 400, message: 'bad json' });

  const unreadable = await report({
    readBodyText: () => Promise.reject(new Error('stream closed')),
  });
  assert.deepEqual(unreadable, { ok: false, status: 400, message: 'unreadable body' });

  const oversized = await report({ readBodyText: async () => 'x'.repeat(5_000) });
  assert.deepEqual(oversized, { ok: false, status: 400, message: 'body too large' });
});

test('rejects a body carrying no usable url', async () => {
  for (const body of [{}, { url: 42 }, { url: null }, 'a bare string', null]) {
    const decision = await report({ readBodyText: async () => JSON.stringify(body) });
    assert.deepEqual(decision, { ok: false, status: 400, message: 'bad url' });
  }
});

test('rejects non-https and private-host urls on the literal check', async () => {
  for (const url of [
    'http://runner.example.com',
    'https://127.0.0.1/',
    'https://169.254.169.254/',
    'https://10.1.2.3/',
    'https://[::1]/',
    'https://runner.example.com@169.254.169.254/',
    'not a url',
  ]) {
    const decision = await report({
      body: { url },
      // A literal rejection must not need DNS at all.
      lookup: async () => assert.fail(`resolved ${url} instead of rejecting it`),
    });
    assert.deepEqual(decision, { ok: false, status: 400, message: 'bad url' });
  }
});

test('rejects a public-looking hostname that resolves to a private address', async () => {
  // isSafeRunnerUrl is synchronous and validates the host literal only, so this
  // is the one place the DNS-to-private bypass can be closed.
  for (const address of ['169.254.169.254', '127.0.0.1', '10.0.0.7', '192.168.1.4', '::1']) {
    const decision = await report({
      body: { url: 'https://runner.example.trycloudflare.com' },
      lookup: resolvesTo(address),
    });
    assert.deepEqual(decision, {
      ok: false,
      status: 400,
      message: 'host did not resolve to a public address',
    });
  }
});

test('rejects when any one resolved address is private, or when none resolve', async () => {
  const url = 'https://runner.example.trycloudflare.com';
  const mixed = await report({ body: { url }, lookup: resolvesTo('104.16.132.229', '127.0.0.1') });
  assert.equal(mixed.ok, false);

  const empty = await report({ body: { url }, lookup: async () => [] });
  assert.equal(empty.ok, false);

  const failing = await report({
    body: { url },
    lookup: () => Promise.reject(new Error('NXDOMAIN')),
  });
  assert.equal(failing.ok, false);
});
