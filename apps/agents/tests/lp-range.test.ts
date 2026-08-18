import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DAY_MS,
  OUT_OF_RANGE_EXIT_MS,
  WEEK_MS,
  computeRebalanceLeg,
  formatWholeUnits,
  isInRange,
  nextOutSince,
  pctToTickDelta,
  pruneWindow,
  shouldRebalance,
  snapRange,
  sqrtPriceX96ToUsdtPerWbnb,
} from '../src/agents/lp-range';

test('pctToTickDelta converts 5% to 487 ticks', () => {
  assert.equal(pctToTickDelta(0.05), 487);
});

test('pctToTickDelta scales with the percentage', () => {
  assert.equal(pctToTickDelta(0.01), Math.floor(Math.log(1.01) / Math.log(1.0001)));
  assert.ok(pctToTickDelta(0.1) > pctToTickDelta(0.05));
});

test('snapRange snaps lower down and upper up on spacing 10', () => {
  const { tickLower, tickUpper } = snapRange(12345, 487, 10);
  assert.equal(tickLower, 11850);
  assert.equal(tickUpper, 12840);
  assert.equal(tickLower % 10, 0);
  assert.equal(tickUpper % 10, 0);
  assert.ok(tickLower <= 12345 - 487);
  assert.ok(tickUpper >= 12345 + 487);
});

test('snapRange handles negative ticks (live WBNB/USDT pool trades near -64000)', () => {
  const { tickLower, tickUpper } = snapRange(-64023, 487, 10);
  assert.equal(tickLower, -64510);
  assert.equal(tickUpper, -63530);
  assert.ok(tickLower < -64023 && -64023 < tickUpper);
  assert.equal(Math.abs(tickLower) % 10, 0);
  assert.equal(Math.abs(tickUpper) % 10, 0);
});

test('snapRange with spacing 1 keeps exact bounds', () => {
  const { tickLower, tickUpper } = snapRange(-5, 487, 1);
  assert.equal(tickLower, -492);
  assert.equal(tickUpper, 482);
});

test('snapRange with spacing 50 still contains the current tick', () => {
  const { tickLower, tickUpper } = snapRange(-64041, 487, 50);
  assert.ok(Number.isInteger(tickLower / 50));
  assert.ok(Number.isInteger(tickUpper / 50));
  assert.ok(tickLower <= -64041 - 487);
  assert.ok(tickUpper >= -64041 + 487);
  assert.ok(tickLower < -64041 && -64041 < tickUpper);
});

test('isInRange is lower-inclusive and upper-exclusive', () => {
  assert.equal(isInRange(100, 100, 200), true);
  assert.equal(isInRange(199, 100, 200), true);
  assert.equal(isInRange(200, 100, 200), false);
  assert.equal(isInRange(99, 100, 200), false);
  assert.equal(isInRange(-150, -200, -100), true);
  assert.equal(isInRange(-100, -200, -100), false);
});

test('nextOutSince starts the timer once and preserves it while out', () => {
  const now = 1_000_000;
  assert.equal(nextOutSince(false, null, now), now);
  assert.equal(nextOutSince(false, 500, now), 500);
});

test('nextOutSince resets on re-entry', () => {
  assert.equal(nextOutSince(true, 500, 1_000_000), null);
  assert.equal(nextOutSince(true, null, 1_000_000), null);
});

test('shouldRebalance fires only after more than 30 minutes out', () => {
  const start = 1_000_000;
  assert.equal(shouldRebalance(null, start + OUT_OF_RANGE_EXIT_MS * 2), false);
  assert.equal(shouldRebalance(start, start + OUT_OF_RANGE_EXIT_MS), false);
  assert.equal(shouldRebalance(start, start + OUT_OF_RANGE_EXIT_MS + 1), true);
  assert.equal(shouldRebalance(start, start + 60_000), false);
});

test('re-entry then a fresh excursion restarts the 30 minute clock', () => {
  const t0 = 1_000_000;
  const afterReset = nextOutSince(true, t0, t0 + 10 * 60_000);
  assert.equal(afterReset, null);
  const t1 = t0 + 20 * 60_000;
  const restarted = nextOutSince(false, afterReset, t1);
  assert.equal(restarted, t1);
  assert.equal(shouldRebalance(restarted, t1 + OUT_OF_RANGE_EXIT_MS), false);
  assert.equal(shouldRebalance(restarted, t1 + OUT_OF_RANGE_EXIT_MS + 1), true);
});

test('computeRebalanceLeg sells the WBNB excess to reach 50/50', () => {
  const leg = computeRebalanceLeg(0.01, 2, 800);
  assert.ok(leg);
  assert.equal(leg.sell, 'WBNB');
  assert.ok(Math.abs(leg.notionalUsd - 3) < 1e-9);
  assert.ok(Math.abs(leg.amountUnits - 3 / 800) < 1e-12);
});

test('computeRebalanceLeg sells the USDT excess to reach 50/50', () => {
  const leg = computeRebalanceLeg(0.0025, 8, 800);
  assert.ok(leg);
  assert.equal(leg.sell, 'USDT');
  assert.ok(Math.abs(leg.notionalUsd - 3) < 1e-9);
  assert.ok(Math.abs(leg.amountUnits - 3) < 1e-9);
});

test('computeRebalanceLeg skips when already balanced', () => {
  assert.equal(computeRebalanceLeg(0.005, 4, 800), null);
});

test('computeRebalanceLeg skips imbalances at or under $1', () => {
  assert.equal(computeRebalanceLeg(0.005, 2, 800), null);
  assert.equal(computeRebalanceLeg(0.005, 2.2, 800), null);
  const justOver = computeRebalanceLeg(0.005, 1.9, 800);
  assert.ok(justOver);
  assert.equal(justOver.sell, 'WBNB');
  assert.ok(justOver.notionalUsd > 1);
});

test('computeRebalanceLeg handles zero balances without NaN swaps', () => {
  const leg = computeRebalanceLeg(0, 10, 800);
  assert.ok(leg);
  assert.equal(leg.sell, 'USDT');
  assert.ok(Math.abs(leg.notionalUsd - 5) < 1e-9);
  assert.equal(computeRebalanceLeg(0, 0, 800), null);
});

test('pruneWindow drops entries outside the window, boundary exclusive', () => {
  const now = 10 * WEEK_MS;
  const times = [now - WEEK_MS - 1, now - WEEK_MS, now - WEEK_MS + 1, now - 1, now];
  assert.deepEqual(pruneWindow(times, now, WEEK_MS), [now - WEEK_MS + 1, now - 1, now]);
});

test('pruneWindow supports the weekly-cap check', () => {
  const now = 10 * WEEK_MS;
  const times = [now - 6 * DAY_MS, now - 5 * DAY_MS, now - 2 * DAY_MS, now - DAY_MS + 1];
  assert.equal(pruneWindow(times, now, WEEK_MS).length, 4);
  assert.equal(pruneWindow(times, now, DAY_MS).length, 1);
  const later = now + 2 * DAY_MS;
  assert.equal(pruneWindow(times, later, WEEK_MS).length, 2);
});

test('sqrtPriceX96ToUsdtPerWbnb inverts when USDT is token0', () => {
  const price = 0.00125;
  const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(price) * 2 ** 48)) * BigInt(2) ** BigInt(48);
  const usdtPerWbnb = sqrtPriceX96ToUsdtPerWbnb(sqrtPriceX96, false);
  assert.ok(Math.abs(usdtPerWbnb - 800) < 0.01);
  const direct = sqrtPriceX96ToUsdtPerWbnb(sqrtPriceX96, true);
  assert.ok(Math.abs(direct - 0.00125) < 1e-9);
});

test('sqrtPriceX96ToUsdtPerWbnb matches the live pool probe', () => {
  const probed = BigInt('3226319368666370249255859660');
  const usdtPerWbnb = sqrtPriceX96ToUsdtPerWbnb(probed, false);
  assert.ok(usdtPerWbnb > 500 && usdtPerWbnb < 700);
});

test('formatWholeUnits emits plain decimals accepted by toBaseUnits', () => {
  assert.equal(formatWholeUnits(5), '5');
  assert.equal(formatWholeUnits(0.001875), '0.001875');
  assert.equal(formatWholeUnits(1.5), '1.5');
  assert.match(formatWholeUnits(3 / 800), /^\d+(\.\d+)?$/);
  assert.throws(() => formatWholeUnits(0));
  assert.throws(() => formatWholeUnits(-1));
  assert.throws(() => formatWholeUnits(Number.NaN));
});
