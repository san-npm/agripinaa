import assert from 'node:assert/strict';
import test from 'node:test';

import type { CowOrder, CowTrade } from '@agripinaa/exec-metrics';
import { PROOF_AGENTS } from '@agripinaa/shared';

import { enrichOphisTrades, mapProofLogEntries } from '../src/proof';

const orderUid = (value: number) => `0x${value.toString(16).padStart(112, '0')}`;

function order(uid: string, status: string): CowOrder {
  return {
    uid,
    owner: `0x${'1'.repeat(40)}`,
    status,
    kind: 'sell',
    sellToken: `0x${'2'.repeat(40)}`,
    buyToken: `0x${'3'.repeat(40)}`,
    sellAmount: '100',
    buyAmount: '100',
    receiver: `0x${'1'.repeat(40)}`,
    feeAmount: '0',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    executedSellAmount: status === 'fulfilled' ? '100' : '0',
    executedBuyAmount: status === 'fulfilled' ? '110' : '0',
    validTo: 1_800_000_000,
    appData: `0x${'4'.repeat(64)}`,
    fullAppData: '{"appCode":"ophis"}',
    creationDate: '2026-08-18T18:25:00.000Z',
  };
}

function trade(uid: string): CowTrade {
  return {
    orderUid: uid,
    owner: `0x${'1'.repeat(40)}`,
    txHash: `0x${'a'.repeat(64)}`,
    blockNumber: 70_000_000,
    sellAmount: '100',
    buyAmount: '110',
    sellToken: `0x${'2'.repeat(40)}`,
    buyToken: `0x${'3'.repeat(40)}`,
  };
}

test('maps receipt-bearing agent actions into public proof events', () => {
  const events = mapProofLogEntries([
    {
      at: '2026-08-18T18:25:14.894Z',
      agent: 'yield',
      event: 'supply',
      venue: 'aave',
      amount: '2.4',
      txHash: `0x${'a'.repeat(64)}`,
    },
    {
      at: '2026-08-18T18:38:15.066Z',
      agent: 'health-factor',
      event: 'repair-done',
      repaidUsdt: '0.318059646689966885',
      txHash: `0x${'b'.repeat(64)}`,
    },
    {
      at: '2026-08-18T18:39:00.000Z',
      agent: 'health-factor',
      event: 'hf',
      hf: 1.602,
    },
  ]);

  assert.equal(events.length, 2);
  assert.equal(events[0]?.agent, '269704');
  assert.equal(events[0]?.kind, 'repair');
  assert.equal(events[0]?.hf, 1.602);
  assert.match(events[0]?.summary ?? '', /restoring HF to 1\.60/);
  assert.equal(events[1]?.agentName, 'Agripinaa Harvester');
  assert.equal(events[1]?.kind, 'rotate');
  assert.match(events[1]?.summary ?? '', /2\.4 USDT to Aave/);
});

test('omits receiptless range telemetry without hiding receipt-bearing actions', () => {
  const entries = [0, 1, 2].map((minutes) => ({
    at: `2026-08-18T18:${35 + minutes * 10}:12.000Z`,
    agent: 'lp-range',
    event: 'range-check',
    tokenId: '7173629',
    inRange: true,
  }));
  const events = mapProofLogEntries([
    ...entries,
    {
      at: '2026-08-18T18:24:16.414Z',
      agent: 'lp-range',
      event: 'rebalance-start',
      tokenId: '7173629',
    },
    {
      at: '2026-08-18T18:25:16.414Z',
      agent: 'lp-range',
      event: 'minted',
      tokenId: '7173629',
      txHash: `0x${'c'.repeat(64)}`,
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'mint');
  assert.equal(events.every((event) => Boolean(event.txHash || event.orderUid)), true);
});

test('publishes Ophis submissions only after the orderbook confirms fulfillment', async () => {
  const fulfilledGrid = orderUid(1);
  const openGrid = orderUid(2);
  const fulfilledLp = orderUid(3);
  const cancelledLp = orderUid(4);
  const lookupError = orderUid(5);
  const candidates = mapProofLogEntries([
    ...[
      [fulfilledGrid, '2026-08-18T18:25:00.000Z'],
      [openGrid, '2026-08-18T18:26:00.000Z'],
    ].map(([uid, at]) => ({
      at,
      agent: 'grid',
      event: 'trade-submitted',
      orderUid: uid,
      side: 'sell',
      clipAmount: '0.01',
    })),
    ...[
      [fulfilledLp, '2026-08-18T18:27:00.000Z'],
      [cancelledLp, '2026-08-18T18:28:00.000Z'],
      [lookupError, '2026-08-18T18:29:00.000Z'],
    ].map(([uid, at]) => ({
      at,
      agent: 'lp-range',
      event: 'ophis-swap-submitted',
      orderUid: uid,
      sellToken: 'WBNB',
      buyToken: 'USDT',
      sellAmount: '0.01',
    })),
  ]);
  assert.equal(candidates.every((event) => /^Submitted/.test(event.summary)), true);

  const statuses = new Map([
    [fulfilledGrid, 'fulfilled'],
    [openGrid, 'open'],
    [fulfilledLp, 'fulfilled'],
    [cancelledLp, 'cancelled'],
  ]);
  const events = await enrichOphisTrades(candidates, {
    lookup: {
      async getOrder(uid) {
        const status = statuses.get(uid);
        if (!status) throw new Error('orderbook unavailable');
        return order(uid, status);
      },
      async getTrades({ orderUid: uid }) {
        if (uid === fulfilledLp) throw new Error('trade details unavailable');
        return uid && statuses.get(uid) === 'fulfilled' ? [trade(uid)] : [];
      },
    },
  });

  assert.deepEqual(events.map((event) => event.orderUid).sort(), [fulfilledGrid, fulfilledLp]);
  assert.equal(events.find((event) => event.orderUid === fulfilledGrid)?.txHash, trade(fulfilledGrid).txHash);
  assert.equal(events.find((event) => event.orderUid === fulfilledLp)?.txHash, undefined);
  assert.equal(events.every((event) => event.surplusBps === 1_000), true);
  assert.equal(events.some((event) => /^Filled/.test(event.summary)), true);
  assert.equal(events.some((event) => /^Rebalanced/.test(event.summary)), true);
});

test('verifies more than one lookup batch when the feed has over 12 fulfilled orders', async () => {
  const candidates = mapProofLogEntries(Array.from({ length: 20 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 7, 18, 18, 25, index)).toISOString(),
    agent: 'grid',
    event: 'trade-submitted',
    orderUid: orderUid(index + 10),
    side: 'sell',
  })));
  const lookedUp: string[] = [];
  const events = await enrichOphisTrades(candidates, {
    limit: 40,
    lookup: {
      async getOrder(uid) {
        lookedUp.push(uid);
        return order(uid, 'fulfilled');
      },
      async getTrades() {
        return [];
      },
    },
  });

  assert.equal(events.length, 20);
  assert.equal(lookedUp.length, 20);
});

test('applies the output limit after unsettled candidates are rejected', async () => {
  const openOrders = Array.from({ length: 40 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 7, 18, 19, 0, index)).toISOString(),
    agent: 'grid',
    event: 'trade-submitted',
    orderUid: orderUid(index + 100),
    side: 'sell',
  }));
  const candidates = mapProofLogEntries([
    ...openOrders,
    {
      at: '2026-08-18T18:00:00.000Z',
      agent: 'yield',
      event: 'supply',
      venue: 'aave',
      txHash: `0x${'e'.repeat(64)}`,
    },
  ]);
  let orderLookups = 0;
  let tradeLookups = 0;
  let clock = 0;
  const events = await enrichOphisTrades(candidates, {
    budgetMs: 2,
    limit: 1,
    now: () => clock,
    lookup: {
      async getOrder(uid) {
        orderLookups += 1;
        clock += 1;
        return order(uid, 'open');
      },
      async getTrades() {
        tradeLookups += 1;
        return [];
      },
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'rotate');
  assert.equal(orderLookups, 2);
  assert.equal(tradeLookups, 0);
});

test('bounds total order verification work when the upstream remains unavailable', async () => {
  const candidates = mapProofLogEntries(Array.from({ length: 200 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 7, 18, 20, 0, index)).toISOString(),
    agent: 'grid',
    event: 'trade-submitted',
    orderUid: orderUid(index + 1_000),
    side: 'sell',
  })));
  let clock = 0;
  let orderLookups = 0;
  const events = await enrichOphisTrades(candidates, {
    budgetMs: 5,
    limit: 40,
    now: () => clock,
    lookup: {
      async getOrder() {
        orderLookups += 1;
        clock += 1;
        throw new Error('orderbook timeout');
      },
      async getTrades() {
        throw new Error('must not be called');
      },
    },
  });

  assert.deepEqual(events, []);
  assert.equal(orderLookups, 5);
});

/* ------------------- the agents registered after the first four ----------- */

/*
 * Registration now admits all four expansion agents to PROOF_AGENTS. Without
 * a mapped event each would have an identity but an empty track record, and
 * venus-guardian and yield-b have no chain-backfill path at all.
 */
const NEW_SLUGS = ['grid-b', 'venus-guardian', 'weight-rebalancer', 'yield-b'] as const;
const tokenIdOf = (slug: (typeof NEW_SLUGS)[number]) => PROOF_AGENTS[slug]!.tokenId;

test('grid-b Ophis submissions map to trade candidates on its own pair', () => {
  const uid = orderUid(21);
  const events = mapProofLogEntries(
    [
      {
        at: '2026-08-25T09:00:00.000Z',
        agent: 'grid-b',
        event: 'trade-submitted',
        orderUid: uid,
        side: 'sell',
        level: 'sell:1',
        clipToken: 'BTCB',
        clipAmount: '0.0000186',
      },
    ],
    PROOF_AGENTS,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.agent, tokenIdOf('grid-b'));
  assert.equal(events[0]?.kind, 'trade');
  assert.equal(events[0]?.orderUid, uid);
  // The pair comes from the record, so grid-b never reads as grid's WBNB.
  assert.match(events[0]?.summary ?? '', /0\.0000186 BTCB → USDT/);
  assert.doesNotMatch(events[0]?.summary ?? '', /WBNB/);
});

test('a grid-b buy names the legs the other way round', () => {
  const events = mapProofLogEntries(
    [
      {
        at: '2026-08-25T09:05:00.000Z',
        agent: 'grid-b',
        event: 'trade-submitted',
        orderUid: orderUid(22),
        side: 'buy',
        clipToken: 'USDT',
        clipAmount: '1.5',
      },
    ],
    PROOF_AGENTS,
  );
  assert.match(events[0]?.summary ?? '', /1\.5 USDT → BTCB/);
});

test('venus-guardian repairs map, with its own health factor beside them', () => {
  const events = mapProofLogEntries(
    [
      {
        at: '2026-08-25T09:10:00.000Z',
        agent: 'venus-guardian',
        event: 'repair-done',
        txHash: `0x${'2'.repeat(64)}`,
        repaidUsdt: '0.42',
      },
      // The guardian's own follow-up read. The Aave agent's must not be used.
      { at: '2026-08-25T09:11:00.000Z', agent: 'venus-guardian', event: 'hf', hf: 1.71 },
      { at: '2026-08-25T09:11:30.000Z', agent: 'health-factor', event: 'hf', hf: 1.05 },
    ],
    PROOF_AGENTS,
  );
  const repair = events.find((event) => event.agent === tokenIdOf('venus-guardian'));
  assert.ok(repair, 'the guardian repair reached the feed');
  assert.equal(repair.kind, 'repair');
  assert.equal(repair.hf, 1.71);
  assert.match(repair.summary, /0\.42 USDT, restoring HF to 1\.71/);
});

test('the Aave guardian still reads its own health factor, not the Venus one', () => {
  const events = mapProofLogEntries(
    [
      {
        at: '2026-08-25T09:10:00.000Z',
        agent: 'health-factor',
        event: 'repair-done',
        txHash: `0x${'3'.repeat(64)}`,
        repaidUsdt: '0.31',
      },
      { at: '2026-08-25T09:10:30.000Z', agent: 'venus-guardian', event: 'hf', hf: 3.33 },
      { at: '2026-08-25T09:11:00.000Z', agent: 'health-factor', event: 'hf', hf: 1.44 },
    ],
    PROOF_AGENTS,
  );
  assert.equal(events[0]?.hf, 1.44);
});

test('weight-rebalancer submissions map like the other Ophis rebalances', () => {
  const uid = orderUid(23);
  const events = mapProofLogEntries(
    [
      {
        at: '2026-08-25T09:15:00.000Z',
        agent: 'weight-rebalancer',
        event: 'rebalance-submitted',
        orderUid: uid,
        side: 'sell-base',
        sellToken: 'WBNB',
        buyToken: 'USDT',
        sellAmount: '0.004',
        notionalUsd: 2.6,
      },
    ],
    PROOF_AGENTS,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.agent, tokenIdOf('weight-rebalancer'));
  assert.equal(events[0]?.kind, 'trade');
  assert.equal(events[0]?.orderUid, uid);
  assert.match(events[0]?.summary ?? '', /0\.004 WBNB → USDT/);
});

test('yield-b supplies and withdrawals map like the incumbent harvester', () => {
  const events = mapProofLogEntries(
    [
      {
        at: '2026-08-25T09:20:00.000Z',
        agent: 'yield-b',
        event: 'supply',
        venue: 'venus',
        amount: '1.2',
        txHash: `0x${'4'.repeat(64)}`,
      },
      {
        at: '2026-08-25T09:25:00.000Z',
        agent: 'yield-b',
        event: 'withdraw',
        venue: 'aave',
        txHash: `0x${'5'.repeat(64)}`,
      },
    ],
    PROOF_AGENTS,
  );
  assert.equal(events.length, 2);
  assert.equal(events.every((event) => event.agent === tokenIdOf('yield-b')), true);
  assert.equal(events.every((event) => event.kind === 'rotate'), true);
  assert.match(events[1]?.summary ?? '', /1\.2 USDT to Venus/);
  assert.match(events[0]?.summary ?? '', /Withdrew USDT from Aave/);
});

test('a newly registered agent enters the feed under its pinned identity', () => {
  const events = mapProofLogEntries([
    {
      at: '2026-08-25T09:30:00.000Z',
      agent: 'yield-b',
      event: 'supply',
      venue: 'venus',
      amount: '1.2',
      txHash: `0x${'6'.repeat(64)}`,
    },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.agent, tokenIdOf('yield-b'));
});

test('ignores heartbeats, malformed receipts, and unknown agents', () => {
  const events = mapProofLogEntries([
    { at: '2026-08-18T18:25:00.000Z', agent: 'grid', event: 'tick' },
    { at: '2026-08-18T18:25:01.000Z', agent: 'yield', event: 'supply', txHash: 'nope' },
    { at: '2026-08-18T18:25:02.000Z', agent: 'other', event: 'minted', txHash: `0x${'d'.repeat(64)}` },
  ]);
  assert.deepEqual(events, []);
});
