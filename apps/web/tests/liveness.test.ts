import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentDetail, AgentSummary } from '@agripinaa/agent-index';

import { newState, recordingFetch, withFetch, type FetchState } from './fetch-stub';

/**
 * The endpoint probe, its store, and the activation gate that reads it.
 *
 * Nothing here touches the network or DNS. The probe's transport is injected
 * (`fetchImpl`), every probed url is a public IP literal so the shared guard
 * checks it without a resolver, and the KV REST calls are served out of a Map
 * through the global swap `kv.test.ts` also uses. kv.ts reads its credentials
 * once at import, so the env goes up here and the modules are imported inside
 * each test.
 */
const KV_BASE = 'https://kv.example.test';
process.env.KV_REST_API_URL = KV_BASE;
process.env.KV_REST_API_TOKEN = 'kv-test-token';

/** TEST-NET-3, a public range: an IP literal, so no lookup is made for it. */
const ENDPOINT = 'https://203.0.113.10/status';
const OTHER_ENDPOINT = 'https://203.0.113.11/status';

const loadLiveness = () => import('../src/lib/liveness');
const loadActivatable = () => import('../src/lib/activatable');

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1_000;

/**
 * Serves the Upstash REST commands out of `store`. Anything else arriving here
 * is a probe that ignored its injected transport, so it gets a 500 rather than
 * an answer and `probeCalls` picks it out of the recorded calls.
 */
function stubbed(state: FetchState, store: Map<string, string>): typeof fetch {
  return recordingFetch(state, (url, init) => {
    if (!url.startsWith(`${KV_BASE}/`)) return new Response('no endpoint expected', { status: 500 });
    const rest = url.slice(KV_BASE.length + 1);
    if (rest === '') {
      const command = JSON.parse(String(init?.body ?? '[]')) as string[];
      return Response.json({ result: command.slice(1).map((key) => store.get(key) ?? null) });
    }
    const [command, rawKey] = rest.split('/');
    const key = decodeURIComponent(rawKey ?? '');
    if (command === 'get') return Response.json({ result: store.get(key) ?? null });
    if (command === 'set') {
      store.set(key, String(init?.body ?? ''));
      return Response.json({ result: 'OK' });
    }
    return new Response('unexpected kv command', { status: 500 });
  });
}

const probeCalls = (state: FetchState) => state.calls.filter((c) => !c.url.startsWith(KV_BASE));

/**
 * The probe's transport, handed to `probeEndpoint` as `fetchImpl`. Nothing a
 * probe test does touches the global fetch, so the assertion that a refused url
 * is never requested is about this call and not about whatever else the process
 * happens to be doing. KV keeps using the global swap: that is `kv.ts`'s own
 * transport, and `kv.test.ts` stubs it the same way.
 */
function endpointFetch(state: FetchState, answer: (url: string) => Response): typeof fetch {
  return recordingFetch(state, answer);
}

test('an endpoint that answers is live, with the status it answered', async () => {
  const { probeEndpoint } = await loadLiveness();
  const state = newState();
  const result = await probeEndpoint(ENDPOINT, {
    now: () => NOW,
    fetchImpl: endpointFetch(state, () => Response.json({ ok: true })),
  });

  assert.equal(result.live, true);
  assert.equal(result.status, 200);
  assert.equal(result.checkedAt, new Date(NOW).toISOString());
  assert.equal(result.reason, undefined);
  assert.deepEqual(state.calls, [{ url: ENDPOINT, method: 'GET' }]);
});

test('an x402 paywall and an auth challenge both count as answering', async () => {
  const { probeEndpoint } = await loadLiveness();
  for (const status of [200, 204, 401, 402]) {
    const state = newState();
    const result = await probeEndpoint(ENDPOINT, {
      fetchImpl: endpointFetch(state, () => new Response(null, { status })),
    });
    assert.equal(result.live, true, `status ${status}`);
    assert.equal(result.status, status);
  }
});

test('a server error is an answer that does not count as live', async () => {
  const { probeEndpoint } = await loadLiveness();
  for (const status of [404, 500, 503]) {
    const state = newState();
    const result = await probeEndpoint(ENDPOINT, {
      fetchImpl: endpointFetch(state, () => new Response('nope', { status })),
    });
    assert.equal(result.live, false, `status ${status}`);
    assert.equal(result.status, status);
    assert.equal(result.reason, 'status');
  }
});

test('a probe that times out reports not live rather than throwing', async () => {
  const { probeEndpoint } = await loadLiveness();
  const state = newState();
  const result = await probeEndpoint(ENDPOINT, {
    now: () => NOW,
    fetchImpl: endpointFetch(state, () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }),
  });

  assert.equal(result.live, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.status, undefined);
  assert.equal(result.checkedAt, new Date(NOW).toISOString());
});

test('an endpoint that refuses the connection is not live either', async () => {
  const { probeEndpoint } = await loadLiveness();
  const state = newState();
  const result = await probeEndpoint(ENDPOINT, {
    fetchImpl: endpointFetch(state, () => {
      throw new TypeError('fetch failed');
    }),
  });

  assert.equal(result.live, false);
  assert.equal(result.reason, 'unreachable');
});

test('the budget is the whole probe, not one hop of it', { timeout: 5_000 }, async () => {
  const { probeEndpoint } = await loadLiveness();
  const state = newState();
  // A host that accepts the connection and then says nothing. The guard's own
  // timer is per hop and this stub ignores the abort signal, so only a deadline
  // over the whole probe can answer here.
  const silent: typeof fetch = async (input, init) => {
    state.calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Promise<Response>(() => {});
  };

  const started = Date.now();
  const result = await probeEndpoint(ENDPOINT, { timeoutMs: 60, fetchImpl: silent });
  const elapsed = Date.now() - started;

  assert.equal(result.live, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(elapsed < 1_000, `probe took ${elapsed}ms, past its own budget`);
});

test('a redirect chain cannot multiply the budget', async () => {
  const { probeEndpoint } = await loadLiveness();
  const state = newState();
  let hop = 0;
  const redirecting: typeof fetch = async (input, init) => {
    state.calls.push({ url: String(input), method: init?.method ?? 'GET' });
    hop += 1;
    // Every hop lands on a fresh public literal, so nothing but the hop cap
    // stops the chain.
    return new Response(null, {
      status: 302,
      headers: { location: `https://203.0.113.${hop}/next` },
    });
  };

  const result = await probeEndpoint(ENDPOINT, { fetchImpl: redirecting });

  assert.equal(result.live, false);
  assert.equal(result.reason, 'blocked');
  assert.ok(
    state.calls.length <= 2,
    `${state.calls.length} requests: one hop is followed, and each one costs a timeout`,
  );
});

test('a url the guard refuses is never fetched', async () => {
  const { probeEndpoint } = await loadLiveness();
  const refused = [
    'http://203.0.113.10/status',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/status',
    'https://localhost/status',
    'not a url at all',
  ];
  for (const url of refused) {
    const state = newState();
    const result = await probeEndpoint(url, {
      fetchImpl: endpointFetch(state, () => {
        throw new Error(`the guard let ${url} through`);
      }),
    });
    assert.equal(result.live, false, url);
    assert.equal(result.reason, 'blocked', url);
    assert.deepEqual(state.calls, [], `nothing was fetched for ${url}`);
  }
});

test('a probe result is stored under the agent key and read back', async () => {
  const { getLiveness, livenessKey, recordLiveness } = await loadLiveness();
  const store = new Map<string, string>();
  const state = newState();
  const probes = newState();

  // KV keeps the global swap; the endpoint is answered by the injected
  // transport. `stubbed` refuses any other endpoint call with a 500, so a probe
  // that ignored `fetchImpl` would come back not live.
  const written = await withFetch(
    stubbed(state, store),
    // Leading zeros on the way in, normalised on the way to the key.
    () =>
      recordLiveness(56, '000297380', ENDPOINT, {
        now: () => NOW,
        fetchImpl: endpointFetch(probes, () => Response.json({ ok: true })),
      }),
  );

  assert.equal(written.live, true);
  assert.equal(written.url, ENDPOINT);
  assert.deepEqual(probes.calls, [{ url: ENDPOINT, method: 'GET' }]);
  assert.deepEqual(probeCalls(state), [], 'the probe did not fall back to the global fetch');
  assert.equal(livenessKey(56, '000297380'), 'agripinaa:liveness:56:297380');
  assert.equal(store.has('agripinaa:liveness:56:297380'), true);

  const read = await withFetch(stubbed(state, store), () => getLiveness(56, '297380'));
  assert.deepEqual(read, written);
});

test('a stored result stops counting once it is past the freshness window', async () => {
  const { LIVENESS_TTL_MS, countsAsLive } = await loadLiveness();
  assert.equal(LIVENESS_TTL_MS, 36 * HOUR);
  const record = { url: ENDPOINT, live: true, checkedAt: new Date(NOW).toISOString(), status: 200 };

  assert.equal(countsAsLive(record, ENDPOINT, NOW + 23 * HOUR), true);
  assert.equal(countsAsLive(record, ENDPOINT, NOW + 25 * HOUR), true);
  assert.equal(countsAsLive(record, ENDPOINT, NOW + 37 * HOUR), false);
  assert.equal(countsAsLive(null, ENDPOINT, NOW), false);
  assert.equal(countsAsLive({ ...record, live: false }, ENDPOINT, NOW), false);
  assert.equal(countsAsLive({ ...record, checkedAt: 'never' }, ENDPOINT, NOW), false);
});

test('a result stored for another endpoint does not count for this one', async () => {
  const { countsAsLive } = await loadLiveness();
  const record = { url: ENDPOINT, live: true, checkedAt: new Date(NOW).toISOString(), status: 200 };
  assert.equal(countsAsLive(record, OTHER_ENDPOINT, NOW), false);
});

test('many agents are read in one batch, one answer per id in order', async () => {
  const { getLivenessMany } = await loadLiveness();
  const record = { url: ENDPOINT, live: true, checkedAt: new Date(NOW).toISOString(), status: 200 };
  const store = new Map([['agripinaa:liveness:56:297380', JSON.stringify(record)]]);
  const state = newState();

  const records = await withFetch(stubbed(state, store), () =>
    getLivenessMany([
      { chainId: 56, tokenId: '111' },
      { chainId: 56, tokenId: '000297380' },
      { chainId: 56, tokenId: '222' },
    ]),
  );

  assert.equal(records.length, 3);
  assert.equal(records[0], null);
  assert.deepEqual(records[1], record);
  assert.equal(records[2], null);
  assert.equal(state.calls.length, 1, 'one MGET, not one read per agent');
});

test('an empty id list costs no read', async () => {
  const { getLivenessMany } = await loadLiveness();
  const state = newState();
  const records = await withFetch(stubbed(state, new Map()), () => getLivenessMany([]));
  assert.deepEqual(records, []);
  assert.deepEqual(state.calls, []);
});

/** A third-party listing with its owner's claimed endpoint merged in. */
function claimedAgent(tokenId: string, endpoint = ENDPOINT): AgentDetail {
  return {
    id: `56-${tokenId}`,
    chainId: 56,
    tokenId,
    endpoint,
    claimed: true,
  } as unknown as AgentDetail;
}

test('a listing badges only the claimed endpoints with a fresh answer', async () => {
  const { withLiveness } = await loadLiveness();
  const fresh = (url: string, live: boolean) =>
    JSON.stringify({ url, live, checkedAt: new Date().toISOString(), status: live ? 200 : 500 });
  const store = new Map([
    ['agripinaa:liveness:56:1', fresh(ENDPOINT, true)],
    ['agripinaa:liveness:56:2', fresh(ENDPOINT, false)],
    // A record left behind for a listing whose owner never claimed one.
    ['agripinaa:liveness:56:4', fresh(ENDPOINT, true)],
  ]);
  const unclaimed = { id: '56-4', chainId: 56, tokenId: '4' } as unknown as AgentSummary;
  const state = newState();

  const listed = await withFetch(stubbed(state, store), () =>
    withLiveness([
      claimedAgent('1'),
      claimedAgent('2'),
      claimedAgent('3'),
      unclaimed,
    ]),
  );

  assert.deepEqual(
    listed.map((a) => a.endpointLive),
    [true, undefined, undefined, undefined],
  );
  assert.equal(state.calls.length, 1, 'one batched read for the whole page');
  assert.equal(state.calls[0]!.method, 'POST', 'the batched MGET, not one GET per agent');
});

test('a listing with nothing claimed on it costs no read', async () => {
  const { withLiveness } = await loadLiveness();
  const plain = [
    { id: '56-9', chainId: 56, tokenId: '9' },
    { id: '56-10', chainId: 56, tokenId: '10', claimed: true },
  ] as unknown as AgentSummary[];
  const state = newState();

  const listed = await withFetch(stubbed(state, new Map()), () => withLiveness(plain));
  assert.equal(listed, plain, 'and the same array comes back');
  assert.deepEqual(state.calls, []);
});

test('the activation gate reads the stored record for a claimed endpoint', async () => {
  const { endpointIsLive } = await loadActivatable();
  const fresh = JSON.stringify({
    url: ENDPOINT,
    live: true,
    checkedAt: new Date(Date.now() - HOUR).toISOString(),
    status: 200,
  });
  const store = new Map([['agripinaa:liveness:56:297380', fresh]]);
  const state = newState();

  const live = await withFetch(stubbed(state, store), () =>
    endpointIsLive(claimedAgent('297380')),
  );
  assert.equal(live, true);
  assert.equal(probeCalls(state).length, 0, 'a page render never probes');
});

test('the gate refuses a stale record, a mismatched url, and a missing endpoint', async () => {
  const { endpointIsLive } = await loadActivatable();
  const stale = JSON.stringify({
    url: ENDPOINT,
    live: true,
    checkedAt: new Date(Date.now() - 37 * HOUR).toISOString(),
    status: 200,
  });
  const store = new Map([['agripinaa:liveness:56:297380', stale]]);
  const state = newState();

  assert.equal(
    await withFetch(stubbed(state, store), () => endpointIsLive(claimedAgent('297380'))),
    false,
    'a result older than the window',
  );

  const fresh = JSON.stringify({
    url: OTHER_ENDPOINT,
    live: true,
    checkedAt: new Date().toISOString(),
    status: 200,
  });
  assert.equal(
    await withFetch(
      stubbed(state, new Map([['agripinaa:liveness:56:297380', fresh]])),
      () => endpointIsLive(claimedAgent('297380')),
    ),
    false,
    'a result for an endpoint this agent no longer lists',
  );

  const noEndpoint = { chainId: 56, tokenId: '297380' } as unknown as AgentDetail;
  const state2 = newState();
  assert.equal(
    await withFetch(stubbed(state2, store), () => endpointIsLive(noEndpoint)),
    false,
  );
  assert.deepEqual(state2.calls, [], 'an agent with no endpoint costs no read');
});

test('a first-party agent is not resolved through the endpoint store', async () => {
  const { endpointIsLive } = await loadActivatable();
  // 269703 is Agripinaa Grid, one of ours: its runner is the site's own, and
  // whether a session gets consumed is `managed`, not a probe.
  const fresh = JSON.stringify({
    url: ENDPOINT,
    live: true,
    checkedAt: new Date().toISOString(),
    status: 200,
  });
  const store = new Map([['agripinaa:liveness:56:269703', fresh]]);
  const state = newState();

  const live = await withFetch(stubbed(state, store), () =>
    endpointIsLive(claimedAgent('269703')),
  );
  assert.equal(live, false);
  assert.deepEqual(state.calls, [], 'and it costs no read either');
});

test('the profile reads the reason a refused endpoint carries, not just the verdict', async () => {
  // The record has always carried a status and a reason "for an owner
  // debugging their endpoint"; until endpointStatus existed nothing read them,
  // so an endpoint that answered 404 looked exactly like one never probed.
  const { endpointStatus } = await loadActivatable();
  const refused = JSON.stringify({
    url: ENDPOINT,
    live: false,
    checkedAt: new Date(Date.now() - HOUR).toISOString(),
    status: 404,
    reason: 'status',
  });
  const store = new Map([['agripinaa:liveness:56:297380', refused]]);
  const state = newState();

  const status = await withFetch(stubbed(state, store), () =>
    endpointStatus(claimedAgent('297380')),
  );
  assert.equal(status.live, false);
  assert.equal(status.url, ENDPOINT);
  assert.equal(status.record?.status, 404);
  assert.equal(status.record?.reason, 'status');
  assert.equal(probeCalls(state).length, 0, 'a page render never probes');

  const { endpointProbeLabel } = await import('../src/lib/endpoint-probe');
  assert.equal(endpointProbeLabel(status.record, status.url), 'not live: answered 404');
});

test('an agent with nothing probed reports no record rather than a verdict', async () => {
  const { endpointStatus } = await loadActivatable();
  const state = newState();
  const status = await withFetch(stubbed(state, new Map()), () =>
    endpointStatus(claimedAgent('297380')),
  );
  assert.deepEqual(status, { url: ENDPOINT, record: null, live: false });
});
