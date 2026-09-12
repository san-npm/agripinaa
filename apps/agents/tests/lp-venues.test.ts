import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LP_VENUES, selectLpVenue } from '../src/lp-venues';

test('PancakeSwap stays the venue unless LP_RANGE_VENUE names another; an unknown name refuses to start', () => {
  assert.equal(selectLpVenue(undefined).name, 'pancakeswap-v3');
  assert.equal(selectLpVenue('').name, 'pancakeswap-v3');
  assert.equal(selectLpVenue('uniswap-v3').name, 'uniswap-v3');
  assert.throws(() => selectLpVenue('sushi-v3'), /LP_RANGE_VENUE=sushi-v3 is not one of/);
});

test('each venue reads slot0 with the feeProtocol width its pools actually use', () => {
  const width = (venue: keyof typeof LP_VENUES) => {
    const slot0 = LP_VENUES[venue].poolAbi.find((item) => item.type === 'function' && item.name === 'slot0');
    assert.ok(slot0 && slot0.type === 'function');
    return slot0.outputs[5]!.type;
  };
  assert.equal(width('pancakeswap-v3'), 'uint32');
  assert.equal(width('uniswap-v3'), 'uint8');
});

test('the Uniswap venue is the published BNB deployment and its manager was probed against its factory', () => {
  const uni = LP_VENUES['uniswap-v3'];
  assert.equal(uni.positionManager, '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613');
  assert.equal(uni.factory, '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7');
  // The deepest WBNB/USDT pool at probe time is tried first.
  assert.equal(uni.feeTiers[0], 500);
  assert.notEqual(uni.positionManager, LP_VENUES['pancakeswap-v3'].positionManager);
});
