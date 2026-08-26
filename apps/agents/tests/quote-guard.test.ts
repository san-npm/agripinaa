import assert from 'node:assert/strict';
import { test } from 'node:test';

import { independentMinimumBuyAmount } from '../src/quote-guard';

test('independent floor converts a base-token sale at the guarded pool price', () => {
  assert.equal(
    independentMinimumBuyAmount({
      sellAmount: '0.01',
      buyUnitsPerSellUnit: 600,
      buyDecimals: 18,
      maxDeviationBps: 300,
    }),
    '5820000000000000000',
  );
});

test('independent floor converts a quote-token sale into base units', () => {
  assert.equal(
    independentMinimumBuyAmount({
      sellAmount: '6',
      buyUnitsPerSellUnit: 1 / 600,
      buyDecimals: 18,
      maxDeviationBps: 300,
    }),
    '9700000000000000',
  );
});

test('independent floor fails closed on corrupt inputs or dust', () => {
  assert.throws(() => independentMinimumBuyAmount({ sellAmount: '0', buyUnitsPerSellUnit: 1, buyDecimals: 18 }));
  assert.throws(() => independentMinimumBuyAmount({ sellAmount: '1', buyUnitsPerSellUnit: 0, buyDecimals: 18 }));
  assert.throws(() => independentMinimumBuyAmount({ sellAmount: '0.000000001', buyUnitsPerSellUnit: 0.000000001, buyDecimals: 18 }));
});
