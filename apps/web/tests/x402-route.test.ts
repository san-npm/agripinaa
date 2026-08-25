import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GET } from '../src/app/api/x402/[slug]/status/route';

import { newState, recordingFetch, RUNNER_BASE, streamBody, withFetch } from './fetch-stub';

process.env.AGENTS_BASE_URL = RUNNER_BASE;

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const request = (slug: string) => new Request(`https://agripinaa.test/api/x402/${slug}/status`);

const CHALLENGE = '{"x402Version":2,"error":"payment required","accepts":[]}';

test('a runner 402 passes through with its status and body untouched', async () => {
  const state = newState();
  const stub = recordingFetch(state, () =>
    new Response(CHALLENGE, { status: 402, headers: { 'content-type': 'application/json' } }),
  );
  const res = await withFetch(stub, () => GET(request('grid'), ctx('grid')));
  assert.equal(res.status, 402);
  assert.equal(await res.text(), CHALLENGE);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(state.calls, [{ url: `${RUNNER_BASE}/grid/status`, method: 'GET' }]);
});

test('a slug outside the registry is a 404 and the runner is never asked', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(CHALLENGE, { status: 402 }));
  for (const slug of ['nope', 'healthz', '..%2Fproof', 'GRID', 'grid%2Fstatus']) {
    const res = await withFetch(stub, () => GET(request(slug), ctx(slug)));
    assert.equal(res.status, 404, slug);
  }
  assert.deepEqual(state.calls, []);
});

test('a runner that does not answer is a stated 502, not a hang', async () => {
  const stub = recordingFetch(newState(), () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const res = await withFetch(stub, () => GET(request('grid'), ctx('grid')));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'agent runner unreachable' });
});

test('a runner redirect is refused and its target is never fetched', async () => {
  const state = newState();
  const stub = recordingFetch(state, (url) =>
    url.startsWith(RUNNER_BASE)
      ? new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } })
      : new Response('{"leaked":"instance credentials"}', { status: 200 }),
  );
  const res = await withFetch(stub, () => GET(request('grid'), ctx('grid')));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /leaked/);
  assert.deepEqual(state.calls.map((c) => c.url), [`${RUNNER_BASE}/grid/status`]);
});

test('an upstream body past the cap is cut off and answered 502', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(streamBody(state, 64, 4_096), { status: 200 }));
  const res = await withFetch(stub, () => GET(request('grid'), ctx('grid')));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'oversized upstream response' });
  assert.ok(state.pulled < 64 * 4_096, 'the whole body was read past the cap');
});
