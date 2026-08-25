import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertResolvedHostPublic,
  assertSafeUrl,
  BlockedUrlError,
  OversizedBodyError,
  safeFetchBytes,
  safeFetchJson,
} from '../src/ssrf';

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

// --- streamed body cap and the byte-level fetch --------------------------

/**
 * A fetch stub whose body is a stream of `chunks` chunks of `chunkBytes` each,
 * counting what the consumer actually pulled and whether it cancelled. Public
 * IP literals are used as hosts throughout so no test resolves live DNS: the
 * guard skips the resolver for a literal it has already range-checked.
 */
function streamingFetch(opts: { status?: number; chunks: number; chunkBytes: number; headers?: Record<string, string> }) {
  const state = { pulled: 0, cancelled: false, calls: [] as string[] };
  const stub: typeof fetch = async (input) => {
    state.calls.push(String(input));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= opts.chunks) {
          controller.close();
          return;
        }
        sent += 1;
        state.pulled += opts.chunkBytes;
        controller.enqueue(new Uint8Array(opts.chunkBytes).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status: opts.status ?? 200, headers: opts.headers });
  };
  return { stub, state };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('a body past the cap is cancelled at the cap, not buffered to the end', async () => {
  // 16 chunks of 64 KB is 1 MB against a 256 KB cap. The reader must stop at
  // the first chunk that crosses the cap and cancel the stream. What the
  // source sees pulled is that plus the read-ahead the stream machinery keeps
  // queued (one chunk per layer: the source stream and the Response around
  // it), so the bound is the cap plus three chunks, well short of the body.
  const { stub, state } = streamingFetch({ chunks: 16, chunkBytes: 64 * 1024 });
  const result = await withFetch(stub, () => safeFetchJson('https://8.8.8.8/x'));
  assert.equal(result, null);
  assert.equal(state.cancelled, true, 'the stream was not cancelled');
  assert.ok(state.pulled <= 256 * 1024 + 3 * 64 * 1024, `pulled ${state.pulled} bytes past the cap`);
});

test('safeFetchBytes reports the cap as an OversizedBodyError with a caller-chosen cap', async () => {
  const { stub, state } = streamingFetch({ chunks: 8, chunkBytes: 4_096 });
  await withFetch(stub, () =>
    assert.rejects(() => safeFetchBytes('https://8.8.8.8/x', { maxBytes: 8_192 }), OversizedBodyError),
  );
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled <= 8_192 + 3 * 4_096, `pulled ${state.pulled} bytes past the cap`);
});

test('safeFetchBytes returns a non-ok upstream status with its body intact', async () => {
  // A proxy needs the runner's own 404 and its error message, which the JSON
  // helper collapses to null on purpose.
  const stub: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'agent does not support managed mode' }), { status: 404 });
  const result = await withFetch(stub, () => safeFetchBytes('https://8.8.8.8/x'));
  assert.equal(result.status, 404);
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.bytes)), {
    error: 'agent does not support managed mode',
  });
});

test('a redirect to a private address is refused and never fetched', async () => {
  const { stub, state } = streamingFetch({
    status: 302,
    chunks: 0,
    chunkBytes: 0,
    headers: { location: 'https://169.254.169.254/latest/meta-data/' },
  });
  const result = await withFetch(stub, () => safeFetchJson('https://8.8.8.8/x'));
  assert.equal(result, null);
  assert.deepEqual(state.calls, ['https://8.8.8.8/x'], 'the private location was fetched');
});

test('a redirect on a POST is refused even when the location is public', async () => {
  // Following would either replay the body to a host the caller never named
  // or turn the request into a GET; a proxy does neither.
  const { stub, state } = streamingFetch({
    status: 307,
    chunks: 0,
    chunkBytes: 0,
    headers: { location: 'https://1.1.1.1/elsewhere' },
  });
  await withFetch(stub, () =>
    assert.rejects(
      () => safeFetchBytes('https://8.8.8.8/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      BlockedUrlError,
    ),
  );
  assert.deepEqual(state.calls, ['https://8.8.8.8/x']);
});

test('maxRedirects: 0 refuses a redirect on a GET too', async () => {
  const { stub, state } = streamingFetch({
    status: 302,
    chunks: 0,
    chunkBytes: 0,
    headers: { location: 'https://1.1.1.1/elsewhere' },
  });
  await withFetch(stub, () =>
    assert.rejects(() => safeFetchBytes('https://8.8.8.8/x', { maxRedirects: 0 }), BlockedUrlError),
  );
  assert.deepEqual(state.calls, ['https://8.8.8.8/x']);
});

test('a GET still follows a public redirect and parses the final body', async () => {
  const calls: string[] = [];
  const stub: typeof fetch = async (input) => {
    calls.push(String(input));
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: 'https://1.1.1.1/final' } });
    }
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  };
  const result = await withFetch(stub, () => safeFetchJson('https://8.8.8.8/x'));
  assert.deepEqual(result, { events: [] });
  assert.deepEqual(calls, ['https://8.8.8.8/x', 'https://1.1.1.1/final']);
});
