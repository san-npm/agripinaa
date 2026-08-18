import test from 'node:test';
import assert from 'node:assert/strict';

import { toBaseUnits } from '@agripinaa/shared';

import {
  COOLDOWN_MS,
  clipForLevel,
  computeLevels,
  detectCrossing,
  evaluateGuards,
  inventoryValueUsd,
  isCooldownActive,
  isLossBreach,
  isTrendBreakout,
  priceFromSqrtPriceX96,
  toSignificant,
  unmarkNearCenter,
  type GridLevel,
  type GuardInput,
} from '../src/agents/grid';

const approx = (actual: number, expected: number, eps = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
};

/* ------------------------------ computeLevels ------------------------------ */

test('computeLevels: 4 levels each side at 1.5 percent spacing', () => {
  const levels = computeLevels(100);
  assert.equal(levels.length, 8);
  const byKey = new Map(levels.map((l) => [l.key, l]));
  approx(byKey.get('sell:1')!.price, 101.5);
  approx(byKey.get('sell:2')!.price, 103);
  approx(byKey.get('sell:3')!.price, 104.5);
  approx(byKey.get('sell:4')!.price, 106);
  approx(byKey.get('buy:1')!.price, 98.5);
  approx(byKey.get('buy:2')!.price, 97);
  approx(byKey.get('buy:3')!.price, 95.5);
  approx(byKey.get('buy:4')!.price, 94);
  for (const l of levels) {
    assert.equal(l.side === 'sell' ? l.price > 100 : l.price < 100, true);
  }
});

/* -------------------------- priceFromSqrtPriceX96 -------------------------- */

test('priceFromSqrtPriceX96: sqrt ratio of 1 is price 1 in both orientations', () => {
  const q96 = BigInt(2) ** BigInt(96);
  approx(priceFromSqrtPriceX96(q96, true), 1);
  approx(priceFromSqrtPriceX96(q96, false), 1);
});

test('priceFromSqrtPriceX96: orientations are reciprocal, probe value is sane', () => {
  // sqrtPriceX96 read from the fee-100 WBNB/USDT pool during the 2026-08-18
  // probe, where token0 was USDT (wbnbIsToken0 false) and BNB traded near 603.
  const probed = BigInt('3225957579431052363637709222');
  const usdtPerWbnb = priceFromSqrtPriceX96(probed, false);
  const wbnbPerUsdt = priceFromSqrtPriceX96(probed, true);
  approx(usdtPerWbnb * wbnbPerUsdt, 1, 1e-9);
  assert.ok(usdtPerWbnb > 500 && usdtPerWbnb < 700, `implied price ${usdtPerWbnb}`);
});

/* ------------------------------ toSignificant ------------------------------ */

test('toSignificant: 6 significant digits, fixed notation, trimmed zeros', () => {
  assert.equal(toSignificant(2 / 600, 6), '0.00333333');
  assert.equal(toSignificant(0.0162001294, 6), '0.0162001');
  assert.equal(toSignificant(0.5, 6), '0.5');
  assert.equal(toSignificant(600, 6), '600');
  assert.equal(toSignificant(2 / 2_000_000, 6), '0.000001');
});

test('toSignificant: expands exponent notation instead of emitting it', () => {
  assert.equal(toSignificant(1.23456789e-9, 6), '0.00000000123457');
  assert.equal(toSignificant(1.23456789e9, 6), '1234570000');
});

test('toSignificant output is always accepted by toBaseUnits', () => {
  for (const price of [0.00001, 0.9, 87.65, 603.17, 1_000_000]) {
    const clip = toSignificant(2 / price, 6);
    assert.doesNotThrow(() => toBaseUnits(clip, 18));
  }
});

test('toSignificant rejects zero, negatives, and non-finite values', () => {
  assert.throws(() => toSignificant(0, 6));
  assert.throws(() => toSignificant(-1, 6));
  assert.throws(() => toSignificant(Number.NaN, 6));
});

/* ------------------------------ clipForLevel ------------------------------- */

test('clipForLevel: buy spends a fixed 2 USDT', () => {
  assert.deepEqual(clipForLevel('buy', 603.17), { token: 'USDT', amount: '2' });
});

test('clipForLevel: sell moves 2/price WBNB at 6 significant digits', () => {
  assert.deepEqual(clipForLevel('sell', 600), { token: 'WBNB', amount: '0.00333333' });
});

/* ----------------------------- detectCrossing ------------------------------ */

const LEVELS = computeLevels(100);
const none: string[] = [];

test('detectCrossing: null while price stays inside the first levels', () => {
  assert.equal(detectCrossing(100, 101.4, LEVELS, none), null);
  assert.equal(detectCrossing(100, 98.6, LEVELS, none), null);
});

test('detectCrossing: single sell level crossed', () => {
  const hit = detectCrossing(100, 101.6, LEVELS, none);
  assert.equal(hit?.level.key, 'sell:1');
  assert.equal(hit?.crossedThisTick, true);
});

test('detectCrossing: single buy level crossed', () => {
  const hit = detectCrossing(100, 98.4, LEVELS, none);
  assert.equal(hit?.level.key, 'buy:1');
  assert.equal(hit?.crossedThisTick, true);
});

test('detectCrossing: price exactly at a level counts as crossed', () => {
  const hit = detectCrossing(100, 101.5, LEVELS, none);
  assert.equal(hit?.level.key, 'sell:1');
});

test('detectCrossing: multiple levels jumped in one tick trades once, nearest level', () => {
  const hit = detectCrossing(100, 103.2, LEVELS, none);
  assert.equal(hit?.level.key, 'sell:1');
  assert.equal(hit?.crossedThisTick, true);
});

test('detectCrossing: farther level is picked up later while price stays beyond it', () => {
  const hit = detectCrossing(103.2, 103.2, LEVELS, ['sell:1']);
  assert.equal(hit?.level.key, 'sell:2');
  assert.equal(hit?.crossedThisTick, false);
});

test('detectCrossing: null when every reached level is already marked', () => {
  assert.equal(detectCrossing(103.2, 103.2, LEVELS, ['sell:1', 'sell:2']), null);
});

test('detectCrossing: marked sell levels never block buy levels', () => {
  const hit = detectCrossing(103.2, 98.4, LEVELS, ['sell:1', 'sell:2']);
  assert.equal(hit?.level.key, 'buy:1');
});

/* ---------------------------- unmarkNearCenter ----------------------------- */

test('unmarkNearCenter: clears all marks within half a step of center', () => {
  assert.deepEqual(unmarkNearCenter(100.7, 100, ['sell:1', 'sell:2']), []);
  assert.deepEqual(unmarkNearCenter(99.3, 100, ['buy:1']), []);
  assert.deepEqual(unmarkNearCenter(100.75, 100, ['sell:1']), []);
});

test('unmarkNearCenter: keeps marks outside half a step', () => {
  const marks = ['sell:1'];
  assert.deepEqual(unmarkNearCenter(100.8, 100, marks), marks);
  assert.deepEqual(unmarkNearCenter(99.2, 100, marks), marks);
});

test('unmarkNearCenter: empty marks stay empty', () => {
  assert.deepEqual(unmarkNearCenter(100, 100, []), []);
});

/* -------------------- re-cross after un-mark, full cycle ------------------- */

test('grid cycle: cross, mark, return to center un-marks, re-cross trades again', () => {
  let crossed: string[] = [];

  const first = detectCrossing(100, 101.6, LEVELS, crossed);
  assert.equal(first?.level.key, 'sell:1');
  crossed = [...crossed, first!.level.key];

  assert.equal(detectCrossing(101.6, 101.7, LEVELS, crossed), null);

  crossed = unmarkNearCenter(100.4, 100, crossed);
  assert.deepEqual(crossed, []);

  const second = detectCrossing(100.4, 101.6, LEVELS, crossed);
  assert.equal(second?.level.key, 'sell:1');
  assert.equal(second?.crossedThisTick, true);
});

/* ------------------------------ guard chain -------------------------------- */

const NOW = 1_755_000_000_000;

function guardInput(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    nowMs: NOW,
    lastFillAtMs: null,
    price: 101.6,
    center: 100,
    inventoryNowUsd: 100,
    inventoryStartUsd: 100,
    clipBaseUnits: toBaseUnits('2', 18),
    balanceBaseUnits: toBaseUnits('10', 18),
    allowTrade: () => true,
    ...overrides,
  };
}

test('guards: all pass', () => {
  assert.deepEqual(evaluateGuards(guardInput()), { ok: true });
});

test('guards: cooldown blocks first and never consumes the rate limiter', () => {
  let allowCalls = 0;
  const res = evaluateGuards(
    guardInput({
      lastFillAtMs: NOW - 5 * 60_000,
      allowTrade: () => {
        allowCalls++;
        return true;
      },
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'cooldown', halt: false });
  assert.equal(allowCalls, 0);
});

test('guards: cooldown exactly elapsed no longer blocks', () => {
  const res = evaluateGuards(guardInput({ lastFillAtMs: NOW - COOLDOWN_MS }));
  assert.deepEqual(res, { ok: true });
});

test('guards: rate limit is consulted after cooldown and blocks without halting', () => {
  let allowCalls = 0;
  const res = evaluateGuards(
    guardInput({
      allowTrade: () => {
        allowCalls++;
        return false;
      },
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'rate-limit', halt: false });
  assert.equal(allowCalls, 1);
});

test('guards: trend breakout halts and is evaluated BEFORE the rate limiter', () => {
  // Halting conditions must trip even when the daily rate-limit budget is
  // spent or cooldown is active, so allowTrade must not be consulted first.
  let allowCalls = 0;
  const res = evaluateGuards(
    guardInput({
      price: 107,
      allowTrade: () => {
        allowCalls++;
        return true;
      },
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'trend-breakout', halt: true });
  assert.equal(allowCalls, 0);
});

test('guards: trend breakout halts even during cooldown', () => {
  const res = evaluateGuards(
    guardInput({ price: 107, nowMs: 1000, lastFillAtMs: 900, cooldownMs: 600_000 }),
  );
  assert.deepEqual(res, { ok: false, reason: 'trend-breakout', halt: true });
});

test('guards: a short-balance tick does not consume a rate-limit slot', () => {
  let allowCalls = 0;
  const res = evaluateGuards(
    guardInput({
      balanceBaseUnits: BigInt(0),
      clipBaseUnits: BigInt(1),
      allowTrade: () => {
        allowCalls++;
        return true;
      },
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'insufficient-balance', halt: false });
  assert.equal(allowCalls, 0);
});

test('guards: trend breakout outranks daily loss when both are true', () => {
  const res = evaluateGuards(guardInput({ price: 107, inventoryNowUsd: 80 }));
  assert.deepEqual(res, { ok: false, reason: 'trend-breakout', halt: true });
});

test('guards: daily loss halts', () => {
  const res = evaluateGuards(guardInput({ inventoryNowUsd: 94.9 }));
  assert.deepEqual(res, { ok: false, reason: 'daily-loss', halt: true });
});

test('guards: boundaries are exclusive, exactly 6 percent and 95 percent trade', () => {
  assert.deepEqual(evaluateGuards(guardInput({ price: 106 })), { ok: true });
  assert.deepEqual(evaluateGuards(guardInput({ price: 94, center: 100, inventoryNowUsd: 95 })), {
    ok: true,
  });
});

test('guards: short balance skips without halting', () => {
  const res = evaluateGuards(
    guardInput({
      clipBaseUnits: toBaseUnits('2', 18),
      balanceBaseUnits: toBaseUnits('1.5', 18),
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'insufficient-balance', halt: false });
});

/* ------------------------------ small helpers ------------------------------ */

test('isCooldownActive: null last fill means no cooldown', () => {
  assert.equal(isCooldownActive(NOW, null), false);
  assert.equal(isCooldownActive(NOW, NOW - 1), true);
  assert.equal(isCooldownActive(NOW, NOW - COOLDOWN_MS), false);
});

test('trend and loss predicates', () => {
  assert.equal(isTrendBreakout(106.01, 100), true);
  assert.equal(isTrendBreakout(93.99, 100), true);
  assert.equal(isTrendBreakout(106, 100), false);
  assert.equal(isLossBreach(94.99, 100), true);
  assert.equal(isLossBreach(95, 100), false);
});

test('inventoryValueUsd values WBNB at the reference price', () => {
  approx(inventoryValueUsd(0.01, 4, 600), 10);
});

/* --------------------------- module shape sanity --------------------------- */

test('module export matches the chassis contract', async () => {
  const { gridAgent } = await import('../src/agents/grid');
  assert.equal(gridAgent.name, 'grid');
  assert.equal(gridAgent.category, 'grid');
  assert.equal(gridAgent.tickIntervalMs, 120_000);
  assert.equal(typeof gridAgent.tick, 'function');
  assert.equal(typeof gridAgent.status, 'function');
});

/* Type-only usage so the import is exercised by the typechecker. */
const _levelTypeCheck: GridLevel[] = LEVELS;
void _levelTypeCheck;
