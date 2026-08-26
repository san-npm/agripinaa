import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CowApiError, CowOrderbookClient, isOphisOrder, isOrderUidValid } from '../src/cow';
import { loadOrderFixture, loadTradesFixture } from './fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (url: string) => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetch: impl, urls };
}

test('isOphisOrder is true for the real fixture appData', () => {
  const order = loadOrderFixture();
  assert.equal(isOphisOrder(order), true);
});

test('isOphisOrder is false for other appCodes', () => {
  assert.equal(isOphisOrder({ appData: `0x${'0'.repeat(64)}`, fullAppData: '{"appCode":"CoW Swap","metadata":{}}' }), false);
});

test('isOphisOrder is false for malformed or null fullAppData', () => {
  const appData = `0x${'0'.repeat(64)}`;
  assert.equal(isOphisOrder({ appData, fullAppData: '{not json' }), false);
  assert.equal(isOphisOrder({ appData, fullAppData: null }), false);
  assert.equal(isOphisOrder({ appData, fullAppData: '"just a string"' }), false);
});

test('isOphisOrder rejects appData JSON that was not signed by the owner', () => {
  const order = loadOrderFixture();
  assert.equal(
    isOphisOrder({ ...order, fullAppData: '{"appCode":"ophis","metadata":{}}' }),
    false,
  );
});

test('the order UID binds every signed field returned by the API', () => {
  const order = loadOrderFixture();
  assert.equal(isOrderUidValid(order), true);
  assert.equal(isOrderUidValid({ ...order, buyAmount: (BigInt(order.buyAmount) + 1n).toString() }), false);
});

test('getOrder hits /orders/{uid} on the default BSC base and parses the body', async () => {
  const fixture = loadOrderFixture();
  const { fetch, urls } = fakeFetch(() => jsonResponse(fixture));
  const client = new CowOrderbookClient({ fetch });

  const order = await client.getOrder(fixture.uid);
  assert.equal(urls[0], `https://api.cow.fi/bnb/api/v1/orders/${fixture.uid}`);
  assert.equal(order.uid, fixture.uid);
  assert.equal(order.kind, 'sell');
  assert.equal(order.status, 'fulfilled');
});

test('getAccountOrders builds limit/offset query and validates the limit range', async () => {
  const { fetch, urls } = fakeFetch(() => jsonResponse([]));
  const client = new CowOrderbookClient({ baseUrl: 'https://example.test/api/v1/', fetch });

  await client.getAccountOrders('0x053fff26d28ff4e94dfe862b184f918a50c6f706', { limit: 5, offset: 10 });
  assert.equal(
    urls[0],
    'https://example.test/api/v1/account/0x053fff26d28ff4e94dfe862b184f918a50c6f706/orders?limit=5&offset=10',
  );

  await assert.rejects(
    () => client.getAccountOrders('0x053fff26d28ff4e94dfe862b184f918a50c6f706', { limit: 0 }),
    RangeError,
  );
  await assert.rejects(
    () => client.getAccountOrders('0x053fff26d28ff4e94dfe862b184f918a50c6f706', { limit: 1001 }),
    RangeError,
  );
});

test('getTrades requires exactly one selector and parses the fixture', async () => {
  const trades = loadTradesFixture();
  const { fetch, urls } = fakeFetch(() => jsonResponse(trades));
  const client = new CowOrderbookClient({ fetch });

  const byOwner = await client.getTrades({ owner: '0x053fff26d28ff4e94dfe862b184f918a50c6f706' });
  assert.equal(urls[0], 'https://api.cow.fi/bnb/api/v1/trades?owner=0x053fff26d28ff4e94dfe862b184f918a50c6f706');
  assert.equal(byOwner.length, trades.length);
  const first = byOwner[0];
  assert.ok(first);
  assert.equal(first.txHash, trades[0]?.txHash);
  assert.equal(typeof first.blockNumber, 'number');

  await assert.rejects(() => client.getTrades({}), TypeError);
  await assert.rejects(
    () => client.getTrades({ owner: '0x053fff26d28ff4e94dfe862b184f918a50c6f706', orderUid: '0xabc' }),
    TypeError,
  );
});

test('getSolverCompetitionByTxHash returns null on 404 and throws on other errors', async () => {
  const notFound = new CowOrderbookClient({
    fetch: fakeFetch(() => jsonResponse({ error: 'not found' }, 404)).fetch,
  });
  assert.equal(await notFound.getSolverCompetitionByTxHash('0xdead'), null);

  const errored = new CowOrderbookClient({
    fetch: fakeFetch(() => jsonResponse({ error: 'boom' }, 500)).fetch,
  });
  await assert.rejects(
    () => errored.getSolverCompetitionByTxHash('0xdead'),
    (err: unknown) => err instanceof CowApiError && err.status === 500,
  );

  const found = new CowOrderbookClient({
    fetch: fakeFetch(() => jsonResponse({ auctionId: 7, solutions: [] })).fetch,
  });
  const competition = await found.getSolverCompetitionByTxHash('0xbeef');
  assert.equal(competition?.auctionId, 7);
});
