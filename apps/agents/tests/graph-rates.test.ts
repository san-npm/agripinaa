import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GRAPH_API_KEY = 'not-a-real-key';
process.env.GRAPH_GATEWAY_BASE = 'https://gateway.test/api/subgraphs/id';

const {
  graphConfirms,
  plausibleAgainstChain,
  readGraphRates,
  rescaleVenusBps,
  supplyBpsFromMarkets,
  MESSARI_BSC_BLOCKS_PER_YEAR,
  MAX_GRAPH_VETOES,
  MESSARI_LENDING_SUBGRAPHS,
} = await import('../src/graph-rates');

const USDT = '0x55d398326f99059fF775485246999027B3197955' as const;
/** The cadence Messari assumes; passing it back leaves the subgraph figure untouched. */
const ASSUMED = MESSARI_BSC_BLOCKS_PER_YEAR;

test("Messari's Venus figure is rescaled from its 3-second-block assumption to the measured cadence", () => {
  assert.equal(MESSARI_BSC_BLOCKS_PER_YEAR, 10_512_000);
  // 0.45 s blocks: the chain produces 6.67x the blocks Messari annualizes with.
  const measured = Math.round((365 * 24 * 3600) / 0.45);
  assert.ok(Math.abs(rescaleVenusBps(60, measured) - 400) < 0.5);
  assert.equal(rescaleVenusBps(202, ASSUMED), 202);
});

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
    const read = await readGraphRates(USDT, ASSUMED);
    assert.ok(!('unavailable' in read), JSON.stringify(read));
    assert.equal(read.venusBps, 202);
    assert.equal(read.aaveBps, 207);
    // At the real cadence the same subgraph answer is worth more; Aave is untouched.
    const faster = await readGraphRates(USDT, ASSUMED * 2);
    assert.ok(!('unavailable' in faster));
    assert.equal(faster.venusBps, 404);
    assert.equal(faster.aaveBps, 207);
  });
  assert.ok('unavailable' in (await readGraphRates(USDT, 0)));
});

test('a subgraph whose head is hours behind the chain is reported unavailable, not used', async () => {
  const answers = {
    [MESSARI_LENDING_SUBGRAPHS.venus]: [market('1', [{ rate: '2', side: 'LENDER', type: 'VARIABLE' }])],
    [MESSARI_LENDING_SUBGRAPHS.aave]: [market('1', [{ rate: '2', side: 'LENDER', type: 'VARIABLE' }])],
  };
  await withFetch(gateway(answers, 7 * 3600), async () => {
    const read = await readGraphRates(USDT, ASSUMED);
    assert.ok('unavailable' in read);
    assert.match(read.unavailable, /indexed head is 7h old/);
  });
});

test('a gateway failure on either venue makes the whole read unavailable', async () => {
  await withFetch((async () => new Response('down', { status: 503 })) as typeof fetch, async () => {
    const read = await readGraphRates(USDT, ASSUMED);
    assert.ok('unavailable' in read);
    assert.match(read.unavailable, /gateway responded 503/);
  });
});

const rotate = { action: 'rotate' as const, target: 'aave' as const, edgeBps: 80, nextStreak: 0 };
const input = { venue: 'venus' as const, betterStreak: 1 };
const agrees = { venusBps: 200, aaveBps: 260, indexedAt: { venus: '', aave: '' }, asOf: '' };
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
  assert.deepEqual(graphConfirms(rotate, input, { unavailable: 'GRAPH_API_KEY not set' }), rotate);
  assert.deepEqual(graphConfirms(rotate, input, null), rotate);
});

test('The Graph can veto but never trigger: equal rates hold, and a hold stays a hold', () => {
  const equal = { ...agrees, aaveBps: 200 };
  assert.equal(graphConfirms(rotate, input, equal).action, 'hold');
  const hold = { action: 'hold' as const, target: 'venus' as const, edgeBps: 0, nextStreak: 0 };
  assert.equal(graphConfirms(hold, input, { ...agrees, aaveBps: 900 }).action, 'hold');
});

test('a subgraph number far from the chain\'s is not a second opinion, it is a broken lane', () => {
  const chain = { venusBps: 242, aaveBps: 278 };
  // Index lag: a few percent off, still the same measurement.
  assert.deepEqual(plausibleAgainstChain(agrees, { venusBps: 205, aaveBps: 250 }), agrees);
  // A stale annualization constant: multiples off, the chain decides alone.
  const off = plausibleAgainstChain({ ...agrees, venusBps: 60 }, chain);
  assert.ok('unavailable' in off && /venus: subgraph says 60.00 bps, chain says 242.00 bps/.test(off.unavailable));
  // An unavailable read passes through untouched.
  assert.deepEqual(plausibleAgainstChain({ unavailable: 'x' }, chain), { unavailable: 'x' });
});

test('a lane that keeps saying no is overruled after MAX_GRAPH_VETOES ticks, so a bias can only delay', () => {
  assert.equal(MAX_GRAPH_VETOES, 3);
  for (let vetoes = 0; vetoes < MAX_GRAPH_VETOES; vetoes++) {
    assert.equal(graphConfirms(rotate, { ...input, graphVetoes: vetoes }, disagrees).action, 'hold', `veto ${vetoes + 1}`);
  }
  const overruled = graphConfirms(rotate, { ...input, graphVetoes: MAX_GRAPH_VETOES }, disagrees);
  assert.equal(overruled.action, 'rotate');
  assert.equal(overruled.graphOverruled, true);
  // Agreement does not need the count at all.
  assert.deepEqual(graphConfirms(rotate, { ...input, graphVetoes: 9 }, agrees), rotate);
});
