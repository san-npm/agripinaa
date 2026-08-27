import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC, toBaseUnits } from '@agripinaa/shared/tokens';

import { buildStrategyScope, hasStrategyAssetFunding } from '../src/lib/strategy-scope';

test('Ranger activation grants USDT, WBNB and native spend ceilings in canonical order', () => {
  const scope = buildStrategyScope('lp-range', 24);
  assert.deepEqual(scope.permissions.spend, [
    {
      token: TOKENS_BSC.USDT!.address,
      period: 'day',
      limit: toBaseUnits('1000000', TOKENS_BSC.USDT!.decimals),
    },
    {
      token: TOKENS_BSC.WBNB!.address,
      period: 'day',
      limit: toBaseUnits('100', TOKENS_BSC.WBNB!.decimals),
    },
    { period: 'day', limit: toBaseUnits('0.005', 18) },
  ]);
});

test('Ophis-only strategies do not gain a direct WBNB spend permission', () => {
  const scope = buildStrategyScope('grid', 24);
  assert.deepEqual(
    scope.permissions.spend.map((spend) => spend.token),
    [TOKENS_BSC.USDT!.address, undefined],
  );
});

test('a multi-asset strategy can activate from either inventory leg', () => {
  assert.equal(hasStrategyAssetFunding(['WBNB', 'USDT'], { WBNB: 1n, USDT: 0n }), true);
  assert.equal(hasStrategyAssetFunding(['WBNB', 'USDT'], { WBNB: 0n, USDT: 1n }), true);
  assert.equal(hasStrategyAssetFunding(['WBNB', 'USDT'], { WBNB: 0n, USDT: 0n }), false);
});

test('Guardian remains USDT-only', () => {
  assert.equal(hasStrategyAssetFunding(['USDT'], { WBNB: 1n, USDT: 0n }), false);
  assert.equal(hasStrategyAssetFunding(['USDT'], { USDT: 1n }), true);
});
