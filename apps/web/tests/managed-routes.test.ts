import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POST as manage } from '../src/app/api/managed/[agent]/manage/route';
import { GET as managerKey } from '../src/app/api/managed/[agent]/manager-key/route';

import { newState, recordingFetch, RUNNER_BASE, streamBody, withFetch } from './fetch-stub';

process.env.AGENTS_BASE_URL = RUNNER_BASE;

const ctx = (agent: string) => ({ params: Promise.resolve({ agent }) });
const keyRequest = (token = 'USDT') =>
  new Request(`https://agripinaa.test/api/managed/yield/manager-key?token=${token}`);
const manageRequest = (body = '{"account":"0x1"}') =>
  new Request('https://agripinaa.test/api/managed/yield/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

const METADATA = 'https://169.254.169.254/latest/meta-data/';
const redirectToMetadata = (state = newState()) => ({
  state,
  stub: recordingFetch(state, (url) =>
    url.startsWith(RUNNER_BASE)
      ? new Response(null, { status: 302, headers: { location: METADATA } })
      : new Response('{"leaked":"instance credentials"}', { status: 200 }),
  ),
});

test('manager-key: a runner redirect is answered 502 and the redirect target is never fetched', async () => {
  const { stub, state } = redirectToMetadata();
  const res = await withFetch(stub, () => managerKey(keyRequest(), ctx('yield')));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /leaked/);
  assert.deepEqual(state.calls.map((c) => c.url), [`${RUNNER_BASE}/yield/manager-key?token=USDT`]);
});

test('manage: a runner redirect is answered 502 and the body is never replayed elsewhere', async () => {
  const { stub, state } = redirectToMetadata();
  const res = await withFetch(stub, () => manage(manageRequest(), ctx('yield')));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /leaked/);
  assert.deepEqual(state.calls, [{ url: `${RUNNER_BASE}/yield/manage`, method: 'POST' }]);
});

test('manager-key: an upstream body past 8 KB is cancelled at the cap and answered 502', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(streamBody(state, 64, 4_096), { status: 200 }));
  const res = await withFetch(stub, () => managerKey(keyRequest(), ctx('yield')));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'oversized upstream response' });
  assert.equal(state.cancelled, true, 'the stream was not cancelled');
  assert.ok(state.pulled <= 8_192 + 3 * 4_096, `pulled ${state.pulled} bytes past the cap`);
});

test('manage: an upstream body past 64 KB is cancelled at the cap and answered 502', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(streamBody(state, 64, 16 * 1024), { status: 200 }));
  const res = await withFetch(stub, () => manage(manageRequest(), ctx('yield')));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'oversized upstream response' });
  assert.equal(state.cancelled, true, 'the stream was not cancelled');
  assert.ok(state.pulled <= 64 * 1024 + 3 * 16 * 1024, `pulled ${state.pulled} bytes past the cap`);
});

test('both routes still pass the runner status and body through', async () => {
  const stub = recordingFetch(newState(), (url) =>
    url.endsWith('/manage')
      ? new Response('{"ok":true,"managedCount":2}', { status: 200 })
      : new Response('{"error":"agent does not support managed mode"}', { status: 404 }),
  );
  const key = await withFetch(stub, () => managerKey(keyRequest(), ctx('yield-b')));
  assert.equal(key.status, 404);
  assert.deepEqual(await key.json(), { error: 'agent does not support managed mode' });
  const reg = await withFetch(stub, () => manage(manageRequest(), ctx('yield')));
  assert.equal(reg.status, 200);
  assert.deepEqual(await reg.json(), { ok: true, managedCount: 2 });
});
