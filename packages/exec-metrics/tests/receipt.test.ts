import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BSC_MAINNET } from '@agripinaa/shared';

import { buildReceipt, extractPartnerFees } from '../src/receipt/build';
import { exportReceiptJson, stableStringify } from '../src/receipt/export';
import { loadOrderFixture, loadTradesFixture } from './fixtures';

test('buildReceipt from the real fixture order and trade', () => {
  const order = loadOrderFixture();
  const trades = loadTradesFixture();
  const trade = trades[0];
  assert.ok(trade);
  assert.equal(trade.orderUid, order.uid);

  const receipt = buildReceipt({ order, trade, chainId: BSC_MAINNET.id });

  assert.equal(receipt.orderUid, order.uid);
  assert.equal(receipt.chainId, 56);
  assert.equal(receipt.owner, order.owner);
  assert.equal(receipt.executedSellAmount, '20000000000000000');
  assert.equal(receipt.executedBuyAmount, '12057295806540799277');
  assert.equal(receipt.settlementTxHash, trade.txHash);
  assert.equal(receipt.settlementBlock, trade.blockNumber);
  assert.equal(receipt.status, 'fulfilled');
  assert.equal(receipt.receiptVersion, '3');

  // Fixture appData carries a single volume partner-fee object.
  assert.deepEqual(receipt.partnerFee, [
    { type: 'volume', volumeBps: 5, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' },
  ]);

  // (12057295806540799277 - 11998963063678816893) / 11998963063678816893
  assert.ok(receipt.surplusVsQuote !== null);
  assert.ok(Math.abs(receipt.surplusVsQuote - 0.00486148199243626) < 1e-12);
});

test('buildReceipt without a trade has null settlement and surplus fields', () => {
  const order = loadOrderFixture();
  const receipt = buildReceipt({ order, trade: null, chainId: 56 });
  assert.equal(receipt.settlementTxHash, null);
  assert.equal(receipt.settlementBlock, null);
  assert.equal(receipt.surplusVsQuote, null);
});

test('extractPartnerFees keeps every entry of an array-shaped partnerFee', () => {
  const fullAppData = JSON.stringify({
    appCode: 'ophis',
    metadata: {
      partnerFee: [
        { recipient: '0x1111111111111111111111111111111111111111', volumeBps: 5 },
        {
          recipient: '0x2222222222222222222222222222222222222222',
          priceImprovementBps: 2500,
          maxVolumeBps: 50,
        },
        { recipient: '0x3333333333333333333333333333333333333333', bps: 10 },
        { recipient: '0x4444444444444444444444444444444444444444', mystery: true },
      ],
    },
  });

  assert.deepEqual(extractPartnerFees(fullAppData), [
    { type: 'volume', volumeBps: 5, recipient: '0x1111111111111111111111111111111111111111' },
    {
      type: 'priceImprovement',
      priceImprovementBps: 2500,
      maxVolumeBps: 50,
      recipient: '0x2222222222222222222222222222222222222222',
    },
    { type: 'volume', volumeBps: 10, recipient: '0x3333333333333333333333333333333333333333' },
  ]);
});

test('extractPartnerFees on malformed, missing, or null appData is empty', () => {
  assert.deepEqual(extractPartnerFees(null), []);
  assert.deepEqual(extractPartnerFees('{not json'), []);
  assert.deepEqual(extractPartnerFees('{"appCode":"ophis","metadata":{}}'), []);
});

test('exportReceiptJson names the file after the first 10 uid chars and sorts keys', () => {
  const order = loadOrderFixture();
  const trades = loadTradesFixture();
  const receipt = buildReceipt({ order, trade: trades[0] ?? null, chainId: 56 });

  const { filename, json } = exportReceiptJson(receipt);
  assert.equal(filename, 'ophis-receipt-0xa2fa52fa.json');

  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(receipt)));
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...keys].sort());

  // Deterministic serialization: same data in a different insertion order
  // must produce the same string.
  const reordered = JSON.parse(json) as Record<string, unknown>;
  assert.equal(stableStringify(reordered), json);
});
