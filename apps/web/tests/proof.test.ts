import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getRunnerEvents, getRunnerEvidence, mergeEvents, normalizeProofEvents } from '../src/lib/proof';
import { signedBps } from '../src/lib/format';

import { newState, recordingFetch, RUNNER_BASE, streamBody, withFetch } from './fetch-stub';

process.env.AGENTS_BASE_URL = RUNNER_BASE;

test('BPS formatting rounds once with truthful signs and handles missing precision', () => {
  assert.equal(signedBps(48.6148199243626), '+48.61');
  assert.equal(signedBps(0.149), '+0.15');
  assert.equal(signedBps(-0.149), '-0.15');
  assert.equal(signedBps(0), '0.00');
  assert.equal(signedBps(-0.001), '0.00');
  assert.equal(signedBps(NaN), 'n/a');
  assert.equal(signedBps(Infinity), 'n/a');
});

const EVENT = {
  agent: '269703',
  kind: 'trade',
  summary: 'Filled WBNB to USDT through Ophis',
  at: '2026-08-24T00:00:00.000Z',
  txHash: `0x${'ab'.repeat(32)}`,
};

test('only explicitly complete runner scans suppress incomplete-history warnings', async () => {
  for (const complete of [true, false, undefined, null, 'true', 1]) {
    const stub = recordingFetch(newState(), url => new Response(JSON.stringify(
      url.startsWith(RUNNER_BASE) ? { events: [EVENT], complete } : [],
    ), { status: 200 }));
    await withFetch(stub, async () => {
      const evidence = await getRunnerEvidence();
      assert.equal(evidence.events.length, 1, 'partial or legacy feeds retain usable evidence');
      assert.equal(evidence.available, complete === true);
    });
  }
  for (const events of [[], null, {}]) {
    const stub = recordingFetch(newState(), () => new Response(JSON.stringify({ events, complete: true })));
    const evidence = await withFetch(stub, () => getRunnerEvidence());
    assert.equal(evidence.available, Array.isArray(events));
  }
});

test('fresh orderbook BPS cannot be overwritten by old runner math', () => {
  const normalized = normalizeProofEvents([{ ...EVENT, surplusBps: 100 }]);
  assert.equal(normalized[0]?.surplusBps, undefined, 'runner-reported BPS is not independently verified');
  const runner = normalized.map((event) => ({ ...event, surplusBps: 100 }));
  const chain = normalizeProofEvents([EVENT]).map((event) => ({ ...event, surplusBps: 48.6148199243626 }));
  assert.equal(mergeEvents(runner, chain)[0]?.surplusBps, 48.6148199243626);
  assert.equal(mergeEvents(runner, normalizeProofEvents([EVENT]))[0]?.surplusBps, undefined);
});

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
