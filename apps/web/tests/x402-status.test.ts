import assert from 'node:assert/strict';
import { test } from 'node:test';

import { askStatusEndpoint } from '../src/lib/x402-status';

import { newState, recordingFetch, RUNNER_BASE, streamBody, withFetch } from './fetch-stub';

process.env.AGENTS_BASE_URL = RUNNER_BASE;

const CHALLENGE = { x402Version: 2, error: 'payment required', accepts: [] };

test('a runner 402 comes back with its status and body as the runner sent them', async () => {
  const state = newState();
  const stub = recordingFetch(state, () =>
    new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { 'content-type': 'application/json' } }),
  );
  const answer = await withFetch(stub, () => askStatusEndpoint('grid'));
  assert.deepEqual(answer, { kind: 'answered', status: 402, body: CHALLENGE });
  assert.deepEqual(state.calls, [{ url: `${RUNNER_BASE}/grid/status`, method: 'GET' }]);
});

test('a body that is not JSON is passed on as null rather than thrown', async () => {
  const stub = recordingFetch(newState(), () => new Response('<html>tunnel error</html>', { status: 530 }));
  const answer = await withFetch(stub, () => askStatusEndpoint('grid'));
  assert.deepEqual(answer, { kind: 'answered', status: 530, body: null });
});

test('a slug outside the registry is refused and the runner is never asked', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(JSON.stringify(CHALLENGE), { status: 402 }));
  for (const slug of ['nope', 'healthz', '../proof', 'GRID', 'grid/status', '']) {
    const answer = await withFetch(stub, () => askStatusEndpoint(slug));
    assert.deepEqual(answer, { kind: 'unknown-agent' }, JSON.stringify(slug));
  }
  assert.deepEqual(state.calls, []);
});

test('a runner that does not answer is stated unreachable, not a hang', async () => {
  const stub = recordingFetch(newState(), () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const answer = await withFetch(stub, () => askStatusEndpoint('grid'));
  assert.deepEqual(answer, { kind: 'unreachable' });
});

test('a runner redirect is refused and its target is never fetched', async () => {
  const state = newState();
  const stub = recordingFetch(state, (url) =>
    url.startsWith(RUNNER_BASE)
      ? new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } })
      : new Response('{"leaked":"instance credentials"}', { status: 200 }),
  );
  const answer = await withFetch(stub, () => askStatusEndpoint('grid'));
  assert.deepEqual(answer, { kind: 'unreachable' });
  assert.deepEqual(state.calls.map((c) => c.url), [`${RUNNER_BASE}/grid/status`]);
});

test('an upstream body past the cap is cut off and stated as oversized', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(streamBody(state, 64, 4_096), { status: 200 }));
  const answer = await withFetch(stub, () => askStatusEndpoint('grid'));
  assert.deepEqual(answer, { kind: 'oversized' });
  assert.ok(state.pulled < 64 * 4_096, 'the whole body was read past the cap');
});
