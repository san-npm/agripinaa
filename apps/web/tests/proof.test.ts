import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getRunnerEvents } from '../src/lib/proof';

import { newState, recordingFetch, RUNNER_BASE, streamBody, withFetch } from './fetch-stub';

process.env.AGENTS_BASE_URL = RUNNER_BASE;

const EVENT = {
  agent: '269703',
  kind: 'trade',
  summary: 'Filled WBNB to USDT through Ophis',
  at: '2026-08-24T00:00:00.000Z',
  txHash: `0x${'ab'.repeat(32)}`,
};

test('a runner redirecting to a private address yields no events and the target is never fetched', async () => {
  const state = newState();
  const stub = recordingFetch(state, (url) =>
    url.startsWith(RUNNER_BASE)
      ? new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } })
      : new Response(JSON.stringify({ events: [EVENT] }), { status: 200 }),
  );
  const events = await withFetch(stub, () => getRunnerEvents());
  assert.deepEqual(events, []);
  assert.deepEqual(state.calls.map((c) => c.url), [`${RUNNER_BASE}/proof`]);
});

test('a proof body past 256 KB is cancelled at the cap and yields no events', async () => {
  const state = newState();
  const stub = recordingFetch(state, () => new Response(streamBody(state, 32, 64 * 1024), { status: 200 }));
  const events = await withFetch(stub, () => getRunnerEvents());
  assert.deepEqual(events, []);
  assert.equal(state.cancelled, true, 'the stream was not cancelled');
  assert.ok(state.pulled <= 256 * 1024 + 3 * 64 * 1024, `pulled ${state.pulled} bytes past the cap`);
});

test('a well-formed proof payload still normalizes into events', async () => {
  const stub = recordingFetch(newState(), () => new Response(JSON.stringify({ events: [EVENT] }), { status: 200 }));
  const events = await withFetch(stub, () => getRunnerEvents());
  assert.equal(events.length, 1);
  assert.equal(events[0]?.agentName, 'Agripinaa Grid');
});
