import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calcSurplusRaw, formatSurplusAmount, summarizeSurplus, surplusBps, surplusToken } from '../src/surplus';
import type { SurplusOrder } from '../src/surplus';
import { loadOrderFixture } from './fixtures';

// Real fulfilled sell order captured from the BSC orderbook:
// executedBuyAmount 12057295806540799277, signed buyAmount 11998963063678816893.
const FIXTURE_SURPLUS_RAW = 58332742861982384n;
const FIXTURE_SURPLUS_BPS = 48.61;

const buyOrderFull: SurplusOrder = {
  kind: 'buy',
  status: 'fulfilled',
  sellToken: '0xsell',
  buyToken: '0xbuy',
  sellAmount: '1000000000000000000',
  buyAmount: '500000000000000000',
  executedSellAmount: '900000000000000000',
  executedBuyAmount: '500000000000000000',
};

const sellOrderPartial: SurplusOrder = {
  kind: 'sell',
  status: 'fulfilled',
  sellToken: '0xsell',
  buyToken: '0xbuy',
  sellAmount: '2000000000000000000',
  buyAmount: '1000000000000000000',
  executedSellAmount: '1000000000000000000',
  executedBuyAmount: '600000000000000000',
};

const unfilledOrder: SurplusOrder = {
  kind: 'sell',
  status: 'expired',
  sellToken: '0xsell',
  buyToken: '0xbuy',
  sellAmount: '1000000000000000000',
  buyAmount: '500000000000000000',
  executedSellAmount: '0',
  executedBuyAmount: '0',
};

test('sell order surplus from the real fixture', () => {
  const order = loadOrderFixture();
  assert.equal(order.kind, 'sell');
  assert.equal(calcSurplusRaw(order), FIXTURE_SURPLUS_RAW);
  assert.equal(surplusToken(order), order.buyToken);
  assert.equal(surplusBps(order), FIXTURE_SURPLUS_BPS);
});

test('buy order surplus is unspent sell amount in sell-token units', () => {
  // limit sell 1e18, executed sell 9e17: surplus 1e17 of the sell token.
  assert.equal(calcSurplusRaw(buyOrderFull), 100000000000000000n);
  assert.equal(surplusToken(buyOrderFull), '0xsell');
  assert.equal(surplusBps(buyOrderFull), 1000);
});

test('unfilled order has null surplus', () => {
  assert.equal(calcSurplusRaw(unfilledOrder), null);
  assert.equal(surplusBps(unfilledOrder), null);
});

test('partial fill compares against the fill-scaled limit', () => {
  // Half the sell amount executed, so the limit is half of 1e18: executed
  // 6e17 beats the 5e17 scaled limit by 1e17 (2000 bps), not by -4e17.
  assert.equal(calcSurplusRaw(sellOrderPartial), 100000000000000000n);
  assert.equal(surplusBps(sellOrderPartial), 2000);
});

test('degenerate signed amounts return null instead of dividing by zero', () => {
  assert.equal(
    calcSurplusRaw({ ...sellOrderPartial, sellAmount: '0' }),
    null,
  );
  assert.equal(
    calcSurplusRaw({ ...buyOrderFull, buyAmount: '0' }),
    null,
  );
});

test('summarizeSurplus counts only fulfilled orders and sums per token', () => {
  const fixture = loadOrderFixture();
  const summary = summarizeSurplus([fixture, buyOrderFull, sellOrderPartial, unfilledOrder]);

  assert.equal(summary.totalOrders, 4);
  assert.equal(summary.filledOrders, 3);
  assert.equal(summary.totalSurplusRaw[fixture.buyToken.toLowerCase()], FIXTURE_SURPLUS_RAW);
  // buyOrderFull surplus (sell token) and sellOrderPartial surplus (buy token)
  // land under their own token keys.
  assert.equal(summary.totalSurplusRaw['0xsell'], 100000000000000000n);
  assert.equal(summary.totalSurplusRaw['0xbuy'], 100000000000000000n);
  const expectedAvg = (FIXTURE_SURPLUS_BPS + 1000 + 2000) / 3;
  assert.ok(Math.abs((summary.avgSurplusBps ?? 0) - expectedAvg) < 1e-9);
});

test('summarizeSurplus over no fulfilled orders yields null average', () => {
  const summary = summarizeSurplus([unfilledOrder]);
  assert.equal(summary.filledOrders, 0);
  assert.deepEqual(summary.totalSurplusRaw, {});
  assert.equal(summary.avgSurplusBps, null);
});

test('formatSurplusAmount uses 18-decimal BNB Chain USDT from the shared registry', () => {
  // 58332742861982384 base units of BSC USDT is about 0.058 USDT, not 58 billion.
  const usdt = '0x55d398326f99059fF775485246999027B3197955';
  assert.equal(formatSurplusAmount(usdt, FIXTURE_SURPLUS_RAW), '0.058332742861982384 USDT');
  assert.equal(formatSurplusAmount(usdt, -1000000000000000000n), '-1 USDT');
  assert.equal(formatSurplusAmount('0x0000000000000000000000000000000000000001', 1500000000000000000n), '1.5');
});
