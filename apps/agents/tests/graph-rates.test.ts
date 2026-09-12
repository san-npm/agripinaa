import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GRAPH_API_KEY = 'not-a-real-key';
process.env.GRAPH_GATEWAY_BASE = 'https://gateway.test/api/subgraphs/id';

const { graphConfirms, readGraphRates, supplyBpsFromMarkets, MESSARI_LENDING_SUBGRAPHS } = await import(
  '../src/graph-rates'
);

const USDT = '0x55d398326f99059fF775485246999027B3197955' as const;

function market(deposit: string, rates: { rate: string; side: string; type: string }[]) {
  return { id: 'm', name: null, totalDepositBalanceUSD: deposit, rates };
}

test('the lender-side variable rate of the deepest market is read as bps', () => {
  const bps = supplyBpsFromMarkets([
    market('1000', [{ rate: '9.9', side: 'LENDER', type: 'VARIABLE' }]),
    market('50000000', [
      { rate: '3.1', side: 'BORROWER', type: 'VARIABLE' },
      { rate: '2.05', side: 'LENDER', type: 'VARIABLE' },
    ]),
  ]);
  assert.equal(bps, 205);
  assert.equal(supplyBpsFromMarkets([]), null);
  assert.equal(supplyBpsFromMarkets([market('1', [{ rate: '1', side: 'BORROWER', type: 'VARIABLE' }])]), null);
});

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function gateway(answers: Record<string, unknown>, headAgeS = 60): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const id = url.slice(url.lastIndexOf('/') + 1);
    const body = JSON.parse(String(init?.body)) as { variables: { token: string } };
    assert.equal(body.variables.token, USDT.toLowerCase(), 'the token is asked lowercase, as the subgraph keys it');
    const data = {
      _meta: { block: { number: 1, timestamp: Math.floor(Date.now() / 1000) - headAgeS } },
      markets: answers[id],
    };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('both venues are read from their pinned Messari deployments', async () => {
  const answers = {
    [MESSARI_LENDING_SUBGRAPHS.venus]: [market('1', [{ rate: '2.02', side: 'LENDER', type: 'VARIABLE' }])],
    [MESSARI_LENDING_SUBGRAPHS.aave]: [market('1', [{ rate: '2.07', side: 'LENDER', type: 'VARIABLE' }])],
  };
  await withFetch(gateway(answers), async () => {
    const read = await readGraphRates(USDT);
    assert.ok(!('unavailable' in read), JSON.stringify(read));
    assert.equal(read.venusBps, 202);
    assert.equal(read.aaveBps, 207);
    assert.equal(read.source, 'the-graph');
  });
});

test('a subgraph whose head is hours behind the chain is reported unavailable, not used', async () => {
  const answers = {
    [MESSARI_LENDING_SUBGRAPHS.venus]: [market('1', [{ rate: '2', side: 'LENDER', type: 'VARIABLE' }])],
    [MESSARI_LENDING_SUBGRAPHS.aave]: [market('1', [{ rate: '2', side: 'LENDER', type: 'VARIABLE' }])],
  };
  await withFetch(gateway(answers, 7 * 3600), async () => {
    const read = await readGraphRates(USDT);
    assert.ok('unavailable' in read);
    assert.match(read.unavailable, /indexed head is 7h old/);
  });
});

test('a gateway failure on either venue makes the whole read unavailable', async () => {
  await withFetch((async () => new Response('down', { status: 503 })) as typeof fetch, async () => {
    const read = await readGraphRates(USDT);
    assert.ok('unavailable' in read);
    assert.match(read.unavailable, /gateway responded 503/);
  });
});

const rotate = { action: 'rotate' as const, target: 'aave' as const, edgeBps: 80, nextStreak: 0 };
const input = { venue: 'venus' as const, betterStreak: 1 };
const agrees = { source: 'the-graph' as const, venusBps: 200, aaveBps: 260, indexedAt: { venus: '', aave: '' }, asOf: '' };
const disagrees = { ...agrees, aaveBps: 190 };

test('a rotation The Graph agrees with goes ahead unchanged', () => {
  assert.deepEqual(graphConfirms(rotate, input, agrees), rotate);
});

test('a rotation The Graph disagrees with becomes a hold that freezes the streak', () => {
  assert.deepEqual(graphConfirms(rotate, input, disagrees), {
    action: 'hold',
    target: 'venus',
    edgeBps: 80,
    nextStreak: 1,
    graphVeto: true,
  });
});

test('a hold, or an unavailable lane, passes through untouched', () => {
  const hold = { action: 'hold' as const, target: 'venus' as const, edgeBps: 10, nextStreak: 0 };
  assert.deepEqual(graphConfirms(hold, input, disagrees), hold);
  assert.deepEqual(graphConfirms(rotate, input, { source: 'the-graph', unavailable: 'GRAPH_API_KEY not set' }), rotate);
  assert.deepEqual(graphConfirms(rotate, input, null), rotate);
});

test('The Graph can veto but never trigger: equal rates hold, and a hold stays a hold', () => {
  const equal = { ...agrees, aaveBps: 200 };
  assert.equal(graphConfirms(rotate, input, equal).action, 'hold');
  const hold = { action: 'hold' as const, target: 'venus' as const, edgeBps: 0, nextStreak: 0 };
  assert.equal(graphConfirms(hold, input, { ...agrees, aaveBps: 900 }).action, 'hold');
});
