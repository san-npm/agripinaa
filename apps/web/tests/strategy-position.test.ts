import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  estimateV3Amounts,
  rangerEmptyState,
  readRangerOwnerOrNull,
  rangerRangeState,
  strategyAccountReadProblem,
  strategyPositionViewState,
} from '../src/lib/strategy-position';

test('legacy sessions without an account stop at an actionable unavailable state', () => {
  assert.match(strategyAccountReadProblem('unknown') ?? '', /no account address/);
  assert.match(strategyAccountReadProblem('0x1234') ?? '', /invalid account/);
  assert.equal(strategyAccountReadProblem('0x1111111111111111111111111111111111111111'), null);
});

test('a failed refresh hides last-known balances instead of calling them live', () => {
  assert.equal(strategyPositionViewState(true, true), 'error');
  assert.equal(strategyPositionViewState(true, false), 'position');
  assert.equal(strategyPositionViewState(false, false), 'loading');
});

test('Ranger marks the upper tick as outside the half-open V3 range', () => {
  assert.equal(rangerRangeState(99, 0, 100), 'in-range');
  assert.equal(rangerRangeState(100, 0, 100), 'out-of-range');
  assert.equal(rangerRangeState(null, 0, 100), 'unknown');
});

test('Ranger claims to be preparing only when its runner and authority are live', () => {
  assert.equal(rangerEmptyState('ready', 'valid', null), 'preparing');
  assert.equal(rangerEmptyState('unavailable', 'valid', null), 'inactive');
  assert.equal(rangerEmptyState('not-registered', 'valid', null), 'inactive');
  assert.equal(rangerEmptyState('ready', 'invalid', null), 'inactive');
  assert.equal(rangerEmptyState('not-registered', 'invalid', '7271073'), 'recorded-unavailable');
});

test('a missing Ranger NFT is isolated from the strategy account balance read', async () => {
  assert.equal(
    await readRangerOwnerOrNull(async () => '0x1111111111111111111111111111111111111111'),
    '0x1111111111111111111111111111111111111111',
  );
  assert.equal(await readRangerOwnerOrNull(async () => {
    throw new Error('ERC721NonexistentToken');
  }), null);
});

test('V3 position estimates keep one-sided liquidity on the correct side', () => {
  const below = estimateV3Amounts(10n ** 18n, -200, -100, 100, 18, 18);
  const above = estimateV3Amounts(10n ** 18n, 200, -100, 100, 18, 18);
  assert.ok(below[0] > 0);
  assert.equal(below[1], 0);
  assert.equal(above[0], 0);
  assert.ok(above[1] > 0);
});
