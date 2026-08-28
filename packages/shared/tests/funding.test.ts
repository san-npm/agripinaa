import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAddress } from 'viem';

import {
  BPS_DENOMINATOR,
  FUNDING_ASSETS,
  FUNDING_QUOTE_BUFFER_BPS,
  PANCAKE_V3_FACTORY_BSC,
  PANCAKE_V3_QUOTER_V2_BSC,
  PANCAKE_V3_SMART_ROUTER_BSC,
  fundingRoute,
  fundingTargetsForAgent,
  isFundingAsset,
  managedTokenForFunding,
  withFundingQuoteBuffer,
  withFundingSlippage,
} from '../src/funding';

describe('four-asset funding policy', () => {
  it('pins the public input set and rejects strategy-only WBNB', () => {
    assert.deepEqual(FUNDING_ASSETS, ['BTCB', 'BNB', 'USDT', 'USDC']);
    for (const asset of FUNDING_ASSETS) assert.equal(isFundingAsset(asset), true);
    assert.equal(isFundingAsset('WBNB'), false);
    assert.equal(isFundingAsset('ETH'), false);
  });

  it('pins syntactically valid live Pancake deployments', () => {
    for (const address of [
      PANCAKE_V3_FACTORY_BSC,
      PANCAKE_V3_QUOTER_V2_BSC,
      PANCAKE_V3_SMART_ROUTER_BSC,
    ]) assert.equal(isAddress(address, { strict: true }), true);
  });

  it('routes every ERC-20 input through pinned liquid edges', () => {
    assert.deepEqual(fundingRoute('USDC', 'BTCB'), {
      tokens: ['USDC', 'USDT', 'WBNB', 'BTCB'],
      fees: [100, 100, 500],
    });
    assert.deepEqual(fundingRoute('BTCB', 'USDC'), {
      tokens: ['BTCB', 'WBNB', 'USDT', 'USDC'],
      fees: [500, 100, 100],
    });
    assert.deepEqual(fundingRoute('USDT', 'USDT'), { tokens: ['USDT'], fees: [] });
  });

  it('prepares both legs for pair agents and the correct stablecoin for yield', () => {
    assert.deepEqual(fundingTargetsForAgent('grid', 'BTCB'), ['WBNB', 'USDT']);
    assert.deepEqual(fundingTargetsForAgent('grid-b', 'BNB'), ['BTCB', 'USDT']);
    assert.deepEqual(fundingTargetsForAgent('lp-range', 'USDC'), ['WBNB', 'USDT']);
    assert.deepEqual(fundingTargetsForAgent('venus-guardian', 'BTCB'), ['USDT']);
    assert.deepEqual(fundingTargetsForAgent('yield', 'USDC'), ['USDC']);
    assert.deepEqual(fundingTargetsForAgent('yield-b', 'BTCB'), ['USDT']);
    assert.equal(managedTokenForFunding('yield', 'USDC'), 'USDC');
    assert.equal(managedTokenForFunding('yield-b', 'BNB'), 'USDT');
  });

  it('rounds gas input up and strategy output down', () => {
    const value = 10_001n;
    const buffered = withFundingQuoteBuffer(value);
    assert.equal(
      buffered,
      (value * (BPS_DENOMINATOR + FUNDING_QUOTE_BUFFER_BPS) + BPS_DENOMINATOR - 1n)
        / BPS_DENOMINATOR,
    );
    assert.ok(buffered > value);
    assert.ok(withFundingSlippage(value) < value);
  });
});
