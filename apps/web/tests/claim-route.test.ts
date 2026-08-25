import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';

import { buildClaimMessage, sanitizeFields } from '../src/lib/claim-message';
// throttle.ts touches no env of its own, so its constants can be imported here;
// anything that reaches kv.ts has to be imported inside a test (see below).
import { CHAIN_READ_LIMIT_PER_CLIENT } from '../src/lib/throttle';

import { newState, recordingFetch, withFetch, type FetchState } from './fetch-stub';

/**
 * The two handlers of /api/claim, over a stubbed KV and a stubbed RPC. What the
 * decisions are is settled in claims.test.ts; what these cover is the wiring
 * the route owns: which query key means what, which status comes back, and
 * (the reason the GET handler stopped reading the chain) exactly which calls a
 * public request costs.
 *
 * KV reads its env once at import, so the vars go up here and the route is
 * imported inside each test.
 */
const KV_BASE = 'https://kv.example.test';
process.env.KV_REST_API_URL = KV_BASE;
process.env.KV_REST_API_TOKEN = 'kv-test-token';

const account = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'66'.repeat(32)}`);

const storedClaim = {
  fields: {
    chainId: 56,
    tokenId: '297380',
    description: 'A yield agent that rotates between BSC lending venues.',
    category: 'yield',
    website: 'https://example.com',
    endpoint: '',
    issuedAt: '2026-08-24T12:00:00.000Z',
  },
  signature: `0x${'ab'.repeat(65)}`,
  signer: account.address,
  savedAt: '2026-08-24T12:00:00.000Z',
};

const CLAIM_KEY = 'agripinaa:claim:56:297380';

/** An address as eth_call returns it: left padded to 32 bytes. */
const asWord = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

/**
 * A fetch that serves the Upstash REST commands this route uses out of `store`,
 * and hands anything else (an RPC url) to `rpc`.
 */
function stubbed(
  state: FetchState,
  store: Map<string, string>,
  rpc: (url: string) => Response = () => new Response('no rpc expected', { status: 500 }),
) {
  return recordingFetch(state, (url, init) => {
    if (!url.startsWith(`${KV_BASE}/`)) return rpc(url);
    // MGET goes to the base as a command array rather than as a path; it is
    // what the chain-read counter reads its two buckets with.
    if (url === `${KV_BASE}/`) {
      const command = JSON.parse(String(init?.body ?? '[]')) as string[];
      if (command[0] !== 'MGET') return new Response('unexpected kv command', { status: 500 });
      return Response.json({ result: command.slice(1).map((k) => store.get(k) ?? null) });
    }
    const [command, rawKey] = url.slice(KV_BASE.length + 1).split('/');
    const key = decodeURIComponent(rawKey ?? '');
    if (command === 'get') return Response.json({ result: store.get(key) ?? null });
    if (command === 'set') {
      store.set(key, String(init?.body ?? ''));
      return Response.json({ result: 'OK' });
    }
    return new Response('unexpected kv command', { status: 500 });
  });
}

const claimUrl = (query: string) => `https://agripinaa.test/api/claim?${query}`;

/** A public IP literal, so probing it costs no dns lookup and no live request. */
const ENDPOINT = 'https://203.0.113.20/status';

const offKvCalls = (state: FetchState) => state.calls.filter((c) => !c.url.startsWith(KV_BASE));
const rpcCalls = (state: FetchState) => offKvCalls(state).filter((c) => c.url !== ENDPOINT);
const probeCalls = (state: FetchState) => offKvCalls(state).filter((c) => c.url === ENDPOINT);

test('GET answers the stored claim, leading zeros and all, without one rpc call', async () => {
  const { GET } = await import('../src/app/api/claim/route');
  const store = new Map([[CLAIM_KEY, JSON.stringify(storedClaim)]]);
  const state = newState();

  const res = await withFetch(stubbed(state, store), () =>
    GET(new Request(claimUrl('chainId=56&tokenId=000297380'))),
  );

  assert.equal(res.status, 200);
  const body = (await res.json()) as { claim: { signer: string; fields: { tokenId: string } } };
  assert.equal(body.claim.signer, account.address);
  assert.equal(body.claim.fields.tokenId, '297380');
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=30/);
  assert.deepEqual(rpcCalls(state), [], 'a public claim read must not spend the site rpc budget');
  assert.equal(state.calls.length, 1);
});

test('GET reports an agent with no claim as having none', async () => {
  const { GET } = await import('../src/app/api/claim/route');
  const state = newState();
  const res = await withFetch(stubbed(state, new Map()), () =>
    GET(new Request(claimUrl('chainId=56&tokenId=111'))),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'no claim for this agent' });
});

test('GET drops a claim whose identity has moved to the owner it is given', async () => {
  const { GET } = await import('../src/app/api/claim/route');
  const store = new Map([[CLAIM_KEY, JSON.stringify(storedClaim)]]);
  const state = newState();

  const res = await withFetch(stubbed(state, store), () =>
    GET(new Request(claimUrl(`chainId=56&tokenId=297380&owner=${other.address}`))),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), {
    error: 'this identity has changed hands since it was claimed',
  });
});

test('GET refuses a query it cannot read before it spends anything', async () => {
  const { GET } = await import('../src/app/api/claim/route');
  const cases = ['chainId=1&tokenId=297380', 'chainId=56&tokenId=%3Bdrop', 'chainId=56'];
  for (const query of cases) {
    const state = newState();
    const res = await withFetch(stubbed(state, new Map()), () => GET(new Request(claimUrl(query))));
    assert.equal(res.status, 400, query);
    assert.deepEqual(state.calls, [], query);
  }
});

test('POST stores a claim signed by the owner the registry reports', async () => {
  const { POST } = await import('../src/app/api/claim/route');
  const fields = sanitizeFields({
    chainId: 56,
    tokenId: '297380',
    description: 'A yield agent that rotates between BSC lending venues.',
    category: 'yield',
    website: 'https://example.com',
    endpoint: ENDPOINT,
    issuedAt: new Date().toISOString(),
  });
  const body = JSON.stringify({
    fields,
    signature: await account.signTypedData(buildClaimMessage(fields)),
  });

  const store = new Map<string, string>();
  const state = newState();
  const res = await withFetch(
    stubbed(state, store, (url) =>
      url === ENDPOINT
        ? Response.json({ ok: true })
        : Response.json({ jsonrpc: '2.0', id: 1, result: asWord(account.address) }),
    ),
    () => POST(new Request(claimUrl(''), { method: 'POST', body })),
  );

  assert.equal(res.status, 200);
  const answered = (await res.json()) as {
    stored: boolean;
    liveness: { url: string; live: boolean; status?: number } | null;
  };
  assert.equal(answered.stored, true);
  // The probe result comes back with the claim, so the form can say what the
  // endpoint answered instead of dropping it and leaving the owner guessing.
  assert.deepEqual(
    { url: answered.liveness?.url, live: answered.liveness?.live, status: answered.liveness?.status },
    { url: ENDPOINT, live: true, status: 200 },
  );
  assert.equal(store.has(CLAIM_KEY), true);
  assert.deepEqual(JSON.parse(store.get('agripinaa:claims:index')!), ['56:297380']);
  assert.equal(rpcCalls(state).length, 1, 'one ownerOf read and nothing else');
  // The claimed endpoint is probed once the claim is stored, so a fresh claim
  // does not wait for the next re-probe to show what its endpoint answered.
  assert.equal(probeCalls(state).length, 1, 'the claimed endpoint was probed once');
  const liveness = JSON.parse(store.get('agripinaa:liveness:56:297380')!) as {
    url: string;
    live: boolean;
    status: number;
    checkedAt: string;
  };
  assert.equal(liveness.url, ENDPOINT);
  assert.equal(liveness.live, true);
  assert.equal(liveness.status, 200);
  assert.ok(Number.isFinite(Date.parse(liveness.checkedAt)), 'the result is timestamped');
});

test('POST probes nothing for a claim that carries no endpoint', async () => {
  const { POST } = await import('../src/app/api/claim/route');
  const fields = sanitizeFields({
    chainId: 56,
    tokenId: '297380',
    description: 'A yield agent that rotates between BSC lending venues.',
    category: 'yield',
    website: 'https://example.com',
    endpoint: '',
    issuedAt: new Date().toISOString(),
  });
  const body = JSON.stringify({
    fields,
    signature: await account.signTypedData(buildClaimMessage(fields)),
  });

  const store = new Map<string, string>();
  const state = newState();
  const res = await withFetch(
    stubbed(state, store, () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: asWord(account.address) }),
    ),
    () => POST(new Request(claimUrl(''), { method: 'POST', body })),
  );

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { liveness: unknown }).liveness, null, 'nothing to report');
  assert.equal(store.has(CLAIM_KEY), true);
  assert.equal(rpcCalls(state).length, 1, 'the ownerOf read, and nothing fetched after it');
  assert.equal([...store.keys()].some((k) => k.startsWith('agripinaa:liveness:')), false);
});

test('POST answers 503 when the chain cannot be read, so the browser retries', async () => {
  const { POST } = await import('../src/app/api/claim/route');
  const fields = sanitizeFields({
    chainId: 56,
    tokenId: '297380',
    description: 'A yield agent that rotates between BSC lending venues.',
    category: 'yield',
    website: '',
    endpoint: '',
    issuedAt: new Date().toISOString(),
  });
  const body = JSON.stringify({
    fields,
    signature: await account.signTypedData(buildClaimMessage(fields)),
  });

  const store = new Map<string, string>();
  const state = newState();
  const res = await withFetch(
    stubbed(state, store, () => new Response('<html>bad gateway</html>', { status: 400 })),
    () => POST(new Request(claimUrl(''), { method: 'POST', body })),
  );

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    stored: false,
    error: 'the chain is not answering right now, please try again',
  });
  // Nothing was stored about the claim. The chain-read counters are the one
  // thing a refused request still writes: it spent the read they exist to cap.
  assert.deepEqual(
    [...store.keys()].filter((key) => !key.startsWith('agripinaa:chain-reads:')),
    [],
  );
});

test('POST refuses a body that is not a claim without reading the chain', async () => {
  const { POST } = await import('../src/app/api/claim/route');
  const state = newState();
  const res = await withFetch(stubbed(state, new Map()), () =>
    POST(new Request(claimUrl(''), { method: 'POST', body: 'not json at all' })),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { stored: false, error: 'bad json' });
  assert.deepEqual(state.calls, []);
});

test('POST stops reading the chain once the minute of chain reads is spent', async () => {
  const { POST } = await import('../src/app/api/claim/route');
  const { CHAIN_READS_SPENT } = await import('../src/lib/claims');
  const stranger = privateKeyToAccount(`0x${'99'.repeat(32)}`);
  const fields = sanitizeFields({
    chainId: 56,
    tokenId: '297380',
    description: 'A yield agent that rotates between BSC lending venues.',
    category: 'yield',
    website: '',
    endpoint: '',
    issuedAt: new Date().toISOString(),
  });
  // Signed by somebody who does not own the agent: the shape of junk that used
  // to cost an ownerOf and a getCode per request with nothing counting them.
  const body = JSON.stringify({
    fields,
    signature: await stranger.signTypedData(buildClaimMessage(fields)),
  });

  const store = new Map<string, string>();
  const state = newState();
  const post = (ip: string) =>
    withFetch(
      stubbed(state, store, () =>
        Response.json({ jsonrpc: '2.0', id: 1, result: asWord(account.address) }),
      ),
      () =>
        POST(
          new Request(claimUrl(''), { method: 'POST', body, headers: { 'x-forwarded-for': ip } }),
        ),
    );

  let last = await post('203.0.113.9');
  for (let i = 1; i < CHAIN_READ_LIMIT_PER_CLIENT; i++) last = await post('203.0.113.9');
  // Refused on its merits, and only after the reads: the stub answers getCode
  // with a non-empty word, so each forged body cost an ownerOf and a getCode.
  assert.equal(last.status, 400);
  const spent = rpcCalls(state).length;
  assert.equal(spent, 2 * CHAIN_READ_LIMIT_PER_CLIENT, 'two chain reads per forged body');

  const throttled = await post('203.0.113.9');
  assert.equal(throttled.status, 429);
  assert.deepEqual(await throttled.json(), { stored: false, error: CHAIN_READS_SPENT });
  assert.equal(rpcCalls(state).length, spent, 'the throttled request read nothing');
});
