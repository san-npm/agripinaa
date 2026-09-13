import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LP_VENUES, POOL_ABI, selectLpVenue } from '../src/lp-venues';

test('PancakeSwap stays the venue unless LP_RANGE_VENUE names another; an unknown name is reported, not thrown', () => {
  assert.deepEqual(selectLpVenue(undefined), { venue: LP_VENUES['pancakeswap-v3'] });
  assert.deepEqual(selectLpVenue(''), { venue: LP_VENUES['pancakeswap-v3'] });
  assert.deepEqual(selectLpVenue('uniswap-v3'), { venue: LP_VENUES['uniswap-v3'] });
  const bad = selectLpVenue('sushi-v3');
  assert.ok('error' in bad && /LP_RANGE_VENUE=sushi-v3 is not one of/.test(bad.error));
});

test('one pool ABI reads both venues: slot0 is decoded word by word, so the feeProtocol width does not matter', () => {
  const slot0 = POOL_ABI.find((item) => item.type === 'function' && item.name === 'slot0');
  assert.ok(slot0 && slot0.type === 'function');
  assert.equal(slot0.outputs.length, 7);
});

test('the Uniswap venue is the published BNB deployment and its manager was probed against its factory', () => {
  const uni = LP_VENUES['uniswap-v3'];
  assert.equal(uni.positionManager, '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613');
  assert.equal(uni.factory, '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7');
  // The deepest WBNB/USDT pool at probe time is tried first.
  assert.equal(uni.feeTiers[0], 500);
  assert.notEqual(uni.positionManager, LP_VENUES['pancakeswap-v3'].positionManager);
});
