import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classify } from '../src/classify';
import type { Category } from '../src/types';

/**
 * The classifier reads what a registration says about itself. These cases are
 * written from the two things the registry actually contains: our own agents
 * and the claimed listings, which describe a strategy, and the airdrop-farming
 * long tail, which describes nothing. Both halves are asserted, because a
 * keyword set that labels the second half is worse than one that leaves it
 * alone: a hub full of `rohit.agent` is not a hub.
 */
function cat(name: string, description = '', extraText?: string): Category | null {
  return classify({ name, description, extraText });
}

test('grid names and descriptions land in the grid hub', () => {
  assert.equal(cat('Grid Bot'), 'grid');
  assert.equal(cat('DCA grid trader'), 'grid');
  assert.equal(cat('BNB Spot Grid', 'places a grid of orders between two prices'), 'grid');
  assert.equal(cat('Reversion Keeper', 'a mean reversion strategy on BNB'), 'grid');
});

test('liquidation and collateral wording lands in the health-factor hub', () => {
  assert.equal(cat('Liquidation protection'), 'health-factor');
  assert.equal(cat('Health factor monitor'), 'health-factor');
  assert.equal(cat('LTV Guard', 'keeps your borrow position under a safe LTV on Venus'), 'health-factor');
  assert.equal(cat('Deleverage keeper', 'unwinds leverage when the buffer thins'), 'health-factor');
  assert.equal(cat('Collateral top-up', 'adds collateral when the ratio drops'), 'health-factor');
});

test('rate and compounding wording lands in the yield hub', () => {
  assert.equal(cat('APY optimizer'), 'yield');
  assert.equal(cat('Yield router'), 'yield');
  assert.equal(cat('Rate Hunter', 'moves idle stablecoins to the best lending market on BNB Chain'), 'yield');
  assert.equal(cat('Stake Router', 'compounds staking rewards weekly'), 'yield');
  assert.equal(cat('Auto-compounder', 'auto compounds a vault position'), 'yield');
});

test('position and weight wording lands in the rebalancing hub', () => {
  assert.equal(cat('LP range manager'), 'rebalancing');
  assert.equal(cat('Position rebalancer'), 'rebalancing');
  assert.equal(cat('LP Manager', 'keeps a PancakeSwap position inside its band'), 'rebalancing');
  assert.equal(cat('Weight Drift Keeper', 're-balances the portfolio weights back to target'), 'rebalancing');
});

test('service text counts as signal when the description is empty', () => {
  assert.equal(cat('Vault A', '', 'yield strategy over lending venues'), 'yield');
});

test('registrations with no strategy signal stay uncategorized', () => {
  // Names read off the live BSC index on 2026-08-24. This is what the long
  // tail looks like, and none of it belongs in a hub.
  for (const name of ['Novager7yec618du', 'Lang Thang', 'airdropblogspot.agent', 'rohit.agent']) {
    assert.equal(cat(name), null, name);
  }
  assert.equal(cat('Termix', 'Shuvo3656.agent on Termix Platform'), null);
  assert.equal(cat('', ''), null);
});

test('a bare topic word is not a category', () => {
  // Each of these carries a word one hub uses, in a sense that hub does not
  // mean. Matching them would fill the hubs with agents that do something else.
  assert.equal(cat('Grid Data Oracle', 'publishes electricity grid data on chain'), null);
  assert.equal(cat('Airdrop Farming Bot', 'farms testnet airdrops all day'), null);
  assert.equal(cat('Portfolio Tracker', 'shows your balances in one place'), null);
  assert.equal(cat('Liquidity pool analytics', 'charts pool volume and fees'), null);
});

test('an explicit metadata category outranks the keywords', () => {
  assert.equal(
    classify({ metadata: { category: 'grid' }, name: 'Yield router', description: 'apy' }),
    'grid',
  );
  assert.equal(
    classify({ metadata: { category: '  Health-Factor  ' }, name: 'Agent #1', description: '' }),
    'health-factor',
  );
});

test('a metadata category that is not one of ours falls back to the keywords', () => {
  assert.equal(
    classify({ metadata: { category: 'other' }, name: 'APY optimizer', description: '' }),
    'yield',
  );
  assert.equal(
    classify({ metadata: { category: 42 }, name: 'APY optimizer', description: '' }),
    'yield',
  );
  assert.equal(
    classify({ metadata: { category: 'other' }, name: 'rohit.agent', description: '' }),
    null,
  );
});

test('a text matching two hubs resolves the same way every time', () => {
  // Not a claim about which hub fits better: CATEGORIES order decides, and the
  // point of the assertion is that one agent cannot drift between hubs.
  assert.equal(cat('Grid bot', 'runs a grid of orders and compounds the yield'), 'grid');
});
