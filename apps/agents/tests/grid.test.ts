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

test('guards: daily loss outranks trend breakout when both are true (capital protection first)', () => {
  const res = evaluateGuards(guardInput({ price: 107, inventoryNowUsd: 80 }));
  assert.deepEqual(res, { ok: false, reason: 'daily-loss', halt: true });
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

// --- Adaptive re-center on breakout (instead of permanent halt) ---

import { maybeRecenter, MAX_RECENTERS_PER_DAY } from '../src/agents/grid';

function fakeGridCtx(allow: (kind: string, maxPerDay: number) => boolean) {
  const store = new Map<string, unknown>();
  const logs: Record<string, unknown>[] = [];
  return {
    store,
    logs,
    ctx: {
      state: {
        get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f),
        set: (k: string, v: unknown) => void store.set(k, v),
      },
      // Passed through rather than swallowed so a test can hold a actual budget
      // per action kind and prove the two re-center reasons share one.
      breakers: { allowAction: (kind: string, maxPerDay: number) => allow(kind, maxPerDay) },
      log: (e: Record<string, unknown>) => void logs.push(e),
    } as unknown as Parameters<typeof maybeRecenter>[0],
  };
}

test('maybeRecenter resets center + marks but PRESERVES the loss baseline', () => {
  const { ctx, store } = fakeGridCtx(() => true);
  store.set('center', 600);
  store.set('inventoryStartUsd', 1000);
  store.set('crossedLevels', ['sell:1', 'sell:2']);
  const ok = maybeRecenter(ctx, 720, 850);
  assert.equal(ok, true);
  assert.equal(store.get('center'), 720);
  assert.equal(store.get('lastPrice'), 720);
  assert.deepEqual(store.get('crossedLevels'), []);
  // The drawdown floor must NOT be re-baselined on a re-center.
  assert.equal(store.get('inventoryStartUsd'), 1000);
});

test('maybeRecenter returns false and leaves center untouched once the daily cap is spent', () => {
  const { ctx, store } = fakeGridCtx(() => false);
  store.set('center', 600);
  const ok = maybeRecenter(ctx, 720, 850);
  assert.equal(ok, false);
  assert.equal(store.get('center'), 600);
});

test('re-center cap is a small positive number (a runaway trend still halts)', () => {
  assert.ok(MAX_RECENTERS_PER_DAY >= 1 && MAX_RECENTERS_PER_DAY <= 6);
});

/* --------------------- adaptive clip sizing (shrink only) ------------------ */

import { CLIP_USD, MIN_CLIP_USD, effectiveClipUsd } from '../src/agents/grid';

test('effectiveClipUsd: a funded wallet keeps the full clip', () => {
  assert.equal(effectiveClipUsd(CLIP_USD, 10.11, MIN_CLIP_USD), CLIP_USD);
  assert.equal(effectiveClipUsd(CLIP_USD, 2.538, MIN_CLIP_USD), CLIP_USD);
  assert.equal(effectiveClipUsd(CLIP_USD, 1000, MIN_CLIP_USD), CLIP_USD);
});

test('effectiveClipUsd: the live incident, 1.9964 affordable against a $2 clip', () => {
  assert.equal(effectiveClipUsd(2, 1.9964, 1), 1.9964);
});

test('effectiveClipUsd: affordable under the minimum cannot trade', () => {
  assert.equal(effectiveClipUsd(2, 0.5, 1), 0);
  assert.equal(effectiveClipUsd(2, 0.999999, 1), 0);
});

test('effectiveClipUsd: exact boundaries, affordable equal to desired and to min', () => {
  assert.equal(effectiveClipUsd(2, 2, 1), 2);
  assert.equal(effectiveClipUsd(2, 1, 1), 1);
});

test('effectiveClipUsd: a non-finite or empty balance cannot trade', () => {
  // A non-finite balance is a corrupt read: fail safe and block, matching the
  // tick's existing bad-read handling, rather than quoting against garbage.
  assert.equal(effectiveClipUsd(2, Number.NaN, 1), 0);
  assert.equal(effectiveClipUsd(2, Number.POSITIVE_INFINITY, 1), 0);
  assert.equal(effectiveClipUsd(2, 0, 1), 0);
  assert.equal(effectiveClipUsd(2, -1, 1), 0);
});

test('effectiveClipUsd ONLY EVER SHRINKS: never above desired, never above affordable', () => {
  for (const affordable of [0, 0.4, 1, 1.5, 1.9964, 2, 2.5, 1000]) {
    const got = effectiveClipUsd(CLIP_USD, affordable, MIN_CLIP_USD);
    assert.ok(got <= CLIP_USD, `clip ${got} grew past the desired ${CLIP_USD}`);
    assert.ok(got === 0 || got <= affordable, `clip ${got} exceeded affordable ${affordable}`);
    assert.ok(got === 0 || got >= MIN_CLIP_USD, `clip ${got} fell under the floor`);
  }
});

test('grid minimum clip matches the swap-notional floor the LP agent already uses', async () => {
  // Mirrored, not imported, so pin the two together: a drift here would mean
  // the two agents disagree on what is worth swapping on the same pair.
  const { MIN_SWAP_NOTIONAL_USD } = await import('../src/agents/lp-range');
  assert.equal(MIN_CLIP_USD, MIN_SWAP_NOTIONAL_USD);
});

/* The tick path end to end: size the clip, quote it, run the balance guard. */

test('adapted clip: the 1.9964 USDT wallet now trades instead of blocking', () => {
  // 1,559 trade-blocked events came from being short of a fixed $2 clip by
  // about four tenths of a cent. The adapted clip spends what is actually held.
  const clipUsd = effectiveClipUsd(CLIP_USD, 1.9964, MIN_CLIP_USD);
  const clip = clipForLevel('buy', 705, clipUsd);
  assert.deepEqual(clip, { token: 'USDT', amount: '1.9964' });

  const res = evaluateGuards(
    guardInput({
      clipBaseUnits: toBaseUnits(clip.amount, 18),
      balanceBaseUnits: toBaseUnits('1.9964', 18),
    }),
  );
  assert.deepEqual(res, { ok: true });
});

test('adapted clip: the same wallet blocked under the old fixed $2 clip', () => {
  const res = evaluateGuards(
    guardInput({
      clipBaseUnits: toBaseUnits(String(CLIP_USD), 18),
      balanceBaseUnits: toBaseUnits('1.9964', 18),
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'insufficient-balance', halt: false });
});

test('adapted clip: under the minimum still blocks with insufficient-balance', () => {
  const clipUsd = effectiveClipUsd(CLIP_USD, 0.5, MIN_CLIP_USD);
  assert.equal(clipUsd, 0);
  // The tick quotes the DESIRED size when the effective clip is 0, so a wallet
  // that cannot fund the floor blocks exactly as an empty one does today.
  const clip = clipForLevel('buy', 705, clipUsd > 0 ? clipUsd : CLIP_USD);
  const res = evaluateGuards(
    guardInput({
      clipBaseUnits: toBaseUnits(clip.amount, 18),
      balanceBaseUnits: toBaseUnits('0.5', 18),
    }),
  );
  assert.deepEqual(res, { ok: false, reason: 'insufficient-balance', halt: false });
});

test('adapted clip: a funded wallet is unchanged end to end', () => {
  const clipUsd = effectiveClipUsd(CLIP_USD, 10.11, MIN_CLIP_USD);
  const clip = clipForLevel('buy', 705, clipUsd);
  assert.deepEqual(clip, { token: 'USDT', amount: '2' });
  const res = evaluateGuards(
    guardInput({
      clipBaseUnits: toBaseUnits(clip.amount, 18),
      balanceBaseUnits: toBaseUnits('10.11', 18),
    }),
  );
  assert.deepEqual(res, { ok: true });
});

test('adapted clip: a starved WBNB sell leg shrinks to its own notional', () => {
  const price = 705;
  const wbnb = 0.0021; // about $1.48, under the $2 clip but over the $1 floor
  const clipUsd = effectiveClipUsd(CLIP_USD, wbnb * price, MIN_CLIP_USD);
  approx(clipUsd, 1.4805, 1e-9);
  const clip = clipForLevel('sell', price, clipUsd);
  assert.equal(clip.token, 'WBNB');
  assert.ok(Number(clip.amount) <= wbnb, `sell clip ${clip.amount} exceeded the balance ${wbnb}`);
});

/* ------------------ staleness-driven re-center (drifted center) ------------ */

import {
  GRID_SPACING,
  STALE_RECENTER_MS,
  isGridStale,
  isSuppressedByMark,
  isWithinUnmarkBand,
} from '../src/agents/grid';

/**
 * The live grid as of 2026-08-24: center pinned at 720.016 while price has sat
 * in 703-708 for days. Levels buy:1 709.216, buy:2 698.416, sell:1 730.816;
 * un-mark band 714.616 to 725.416. The whole observed range lies between buy:2
 * and buy:1, so buy:1 is the only reachable level and once it is marked nothing
 * can clear it: the band never reaches 714.616.
 */
const LIVE_CENTER = 720.016;
const LIVE_PRICE = 705;
const HOUR_MS = 3_600_000;
const THREE_DAYS_MS = 72 * HOUR_MS;

/** A working per-kind sliding budget, like Breakers.allowAction. */
function budgetedAllow() {
  const used = new Map<string, number>();
  return {
    used,
    allow: (kind: string, maxPerDay: number) => {
      const n = used.get(kind) ?? 0;
      if (n >= maxPerDay) return false;
      used.set(kind, n + 1);
      return true;
    },
  };
}

/**
 * The tick's stale branch, composed from the same exported functions in the
 * same order the agent composes them: read the persisted fill anchor, test the
 * drought and the suppressing mark, route through the one shared re-center path.
 */
function staleBranch(
  ctx: Parameters<typeof maybeRecenter>[0],
  store: Map<string, unknown>,
  price: number,
  nowMs: number,
  inventoryNowUsd = 100,
): boolean {
  const center = store.get('center') as number;
  const crossed = (store.get('crossedLevels') as string[] | undefined) ?? [];
  const lastFillAtMs = (store.get('lastFillAt') as number | undefined) ?? null;
  if (
    lastFillAtMs !== null &&
    isGridStale(nowMs, lastFillAtMs, price, center) &&
    isSuppressedByMark(price, computeLevels(center), crossed)
  ) {
    const hoursSinceLastFill = (nowMs - lastFillAtMs) / HOUR_MS;
    return maybeRecenter(ctx, price, inventoryNowUsd, 'stale', { hoursSinceLastFill });
  }
  return false;
}

function liveGrid(allow: (kind: string, maxPerDay: number) => boolean = () => true) {
  const h = fakeGridCtx(allow);
  h.store.set('center', LIVE_CENTER);
  h.store.set('lastPrice', LIVE_PRICE);
  h.store.set('inventoryStartUsd', 100);
  h.store.set('crossedLevels', ['buy:1']);
  h.store.set('lastFillAt', NOW - THREE_DAYS_MS);
  return h;
}

test('the live grid is stuck: only buy:1 is reachable and it is marked', () => {
  // Pins the shape the staleness rule exists to break out of. If this ever
  // stops holding, the scenario below is no longer the live one.
  const levels = computeLevels(LIVE_CENTER);
  const byKey = new Map(levels.map((l) => [l.key, l]));
  approx(byKey.get('buy:1')!.price, 709.21576, 1e-6);
  approx(byKey.get('buy:2')!.price, 698.41552, 1e-6);
  approx(byKey.get('sell:1')!.price, 730.81624, 1e-6);

  // Every price in the observed band lies between buy:2 and buy:1, and outside
  // the un-mark band, so a marked buy:1 leaves nothing to trade and nothing to
  // clear: exactly 1 fill, then silence.
  for (const price of [703, 705, 706.5, 708]) {
    assert.equal(detectCrossing(price, price, levels, ['buy:1']), null);
    assert.equal(isWithinUnmarkBand(price, LIVE_CENTER), false);
    assert.deepEqual(unmarkNearCenter(price, LIVE_CENTER, ['buy:1']), ['buy:1']);
    // The mark, and only the mark, is what stops buy:1 trading.
    assert.equal(isSuppressedByMark(price, levels, ['buy:1']), true);
    assert.equal(detectCrossing(price, price, levels, [])?.level.key, 'buy:1');
    // Nowhere near the 6 percent breakout that is the only other escape.
    assert.equal(isTrendBreakout(price, LIVE_CENTER), false);
  }
});

test('isSuppressedByMark: only a mark on a level price already satisfies counts', () => {
  const levels = computeLevels(LIVE_CENTER);
  // Nothing marked: the grid is waiting for a move, not suppressed.
  assert.equal(isSuppressedByMark(LIVE_PRICE, levels, []), false);
  // Marked, and price is beyond it.
  assert.equal(isSuppressedByMark(LIVE_PRICE, levels, ['buy:1']), true);
  assert.equal(isSuppressedByMark(LIVE_PRICE, levels, new Set(['buy:1'])), true);
  // Marked, but price has not reached it: nothing is being held back.
  assert.equal(isSuppressedByMark(712, levels, ['buy:1']), false);
  assert.equal(isSuppressedByMark(LIVE_PRICE, levels, ['sell:1']), false);
  // Sell side behaves the same way.
  assert.equal(isSuppressedByMark(735, levels, ['sell:1']), true);
  assert.equal(isSuppressedByMark(720, levels, ['sell:1']), false);
});

test('isSuppressedByMark implies the price is outside the un-mark band', () => {
  // A level sits at least a full step from center, so price beyond one is
  // always more than half a step out. Pins the two rules against each other.
  const levels = computeLevels(LIVE_CENTER);
  const keys = levels.map((l) => l.key);
  for (let price = 640; price <= 800; price += 0.37) {
    if (isSuppressedByMark(price, levels, keys)) {
      assert.equal(isWithinUnmarkBand(price, LIVE_CENTER), false, `band at ${price}`);
    }
  }
});

test('stale re-center: the live scenario, 3 days without a fill at price 705', () => {
  const { ctx, store, logs } = liveGrid();
  assert.equal(isGridStale(NOW, NOW - THREE_DAYS_MS, LIVE_PRICE, LIVE_CENTER), true);

  assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), true);
  assert.equal(store.get('center'), LIVE_PRICE);
  assert.equal(store.get('lastPrice'), LIVE_PRICE);
  assert.deepEqual(store.get('crossedLevels'), []);
  // The drawdown floor is still anchored to the original baseline.
  assert.equal(store.get('inventoryStartUsd'), 100);

  const log = logs.at(-1)!;
  assert.equal(log.event, 'grid-recenter');
  assert.equal(log.reason, 'stale');
  assert.equal(log.previousCenter, LIVE_CENTER);
  assert.equal(log.center, LIVE_PRICE);
  assert.equal(log.hoursSinceLastFill, 72);
});

test('stale re-center: a fill inside the staleness window does NOT re-center', () => {
  // Price is outside the un-mark band, so only the drought is missing.
  for (const elapsed of [0, HOUR_MS, STALE_RECENTER_MS - 1]) {
    const { ctx, store } = liveGrid();
    store.set('lastFillAt', NOW - elapsed);
    assert.equal(isWithinUnmarkBand(LIVE_PRICE, LIVE_CENTER), false);
    assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), false);
    assert.equal(store.get('center'), LIVE_CENTER);
    assert.deepEqual(store.get('crossedLevels'), ['buy:1']);
  }
  // "At least a staleness window" is inclusive: exactly 12 hours is stale.
  const { ctx, store } = liveGrid();
  store.set('lastFillAt', NOW - STALE_RECENTER_MS);
  assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), true);
});

test('stale re-center: price inside the un-mark band does NOT re-center', () => {
  // The marked level can still clear on its own, so the grid is quiet, not
  // dead, and must not spend re-center budget to fix itself.
  for (const price of [LIVE_CENTER, 716, 720, 724]) {
    const { ctx, store } = liveGrid();
    assert.equal(isWithinUnmarkBand(price, LIVE_CENTER), true);
    assert.deepEqual(unmarkNearCenter(price, LIVE_CENTER, ['buy:1']), []);
    assert.equal(isGridStale(NOW, NOW - THREE_DAYS_MS, price, LIVE_CENTER), false);
    assert.equal(staleBranch(ctx, store, price, NOW), false);
    assert.equal(store.get('center'), LIVE_CENTER);
  }
});

test('stale re-center: the band boundary is inclusive and shared with unmarkNearCenter', () => {
  // Exact-boundary arithmetic, at a center where it is free of float artifacts.
  const old = NOW - THREE_DAYS_MS;
  assert.equal(isWithinUnmarkBand(100.75, 100), true);
  assert.deepEqual(unmarkNearCenter(100.75, 100, ['sell:1']), []);
  assert.equal(isGridStale(NOW, old, 100.75, 100), false);

  assert.equal(isWithinUnmarkBand(100.8, 100), false);
  assert.deepEqual(unmarkNearCenter(100.8, 100, ['sell:1']), ['sell:1']);
  assert.equal(isGridStale(NOW, old, 100.8, 100), true);
});

test('stale re-center: a drought with nothing marked does NOT chase the price', () => {
  // The grid is merely waiting for a 1.5 percent move. Re-centering here would
  // reset the distance to the nearest level from 0.75 percent back to the full
  // 1.5 percent and push the next fill further away. On the recorded BNB tape that
  // is worth roughly half the fills, and it drains the shared re-center budget
  // so a later later breakout halts the agent instead of re-arming it.
  for (const price of [703, 705, 708, 712, 730]) {
    const { ctx, store } = liveGrid();
    store.set('crossedLevels', []);
    assert.equal(isSuppressedByMark(price, computeLevels(LIVE_CENTER), []), false);
    assert.equal(staleBranch(ctx, store, price, NOW), false);
    assert.equal(store.get('center'), LIVE_CENTER);
  }
});

test('stale re-center: a mark the price has NOT reached does not re-center', () => {
  // 712 is outside the un-mark band, and the drought is three days old, but it
  // sits above buy:1 at 709.216: no level is being held back, so there is
  // nothing to rescue and the budget stays unspent.
  const { ctx, store } = liveGrid();
  assert.equal(isWithinUnmarkBand(712, LIVE_CENTER), false);
  assert.equal(isGridStale(NOW, NOW - THREE_DAYS_MS, 712, LIVE_CENTER), true);
  assert.equal(isSuppressedByMark(712, computeLevels(LIVE_CENTER), ['buy:1']), false);
  assert.equal(staleBranch(ctx, store, 712, NOW), false);
  assert.equal(store.get('center'), LIVE_CENTER);
  assert.deepEqual(store.get('crossedLevels'), ['buy:1']);
});

test('stale re-center: a grid that has never filled is not stale', () => {
  // No drought to measure from, and a fresh grid sits on its own center: an
  // infinitely-stale reading would burn the daily budget off the first drift.
  assert.equal(isGridStale(NOW, null, LIVE_PRICE, LIVE_CENTER), false);
  const { ctx, store } = liveGrid();
  store.delete('lastFillAt');
  assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), false);
  assert.equal(store.get('center'), LIVE_CENTER);
});

test('stale re-center: the daily cap is SHARED, a spent breakout budget refuses it', () => {
  const { allow, used } = budgetedAllow();
  const { ctx, store, logs } = liveGrid(allow);

  // Spend the whole daily allowance on breakout re-centers.
  for (let i = 0; i < MAX_RECENTERS_PER_DAY; i++) {
    assert.equal(maybeRecenter(ctx, 800 + i, 100), true);
  }
  assert.equal(used.get('recenter'), MAX_RECENTERS_PER_DAY);
  // Only the spent budget carries over; put the live geometry back.
  store.set('center', LIVE_CENTER);
  store.set('crossedLevels', ['buy:1']);
  const logsBefore = logs.length;

  assert.equal(isGridStale(NOW, NOW - THREE_DAYS_MS, LIVE_PRICE, LIVE_CENTER), true);
  assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), false);
  assert.equal(store.get('center'), LIVE_CENTER);
  assert.deepEqual(store.get('crossedLevels'), ['buy:1']);
  assert.equal(logs.length, logsBefore, 'a refused re-center must not log one');
  assert.equal(used.get('recenter'), MAX_RECENTERS_PER_DAY, 'budget must not be exceeded');
});

test('stale re-center: the daily cap is SHARED in the other direction too', () => {
  const { allow, used } = budgetedAllow();
  const { ctx, store } = liveGrid(allow);

  assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), true);
  assert.equal(used.get('recenter'), 1);
  // A stale re-center leaves the breakout path one fewer, never a fresh set.
  for (let i = 0; i < MAX_RECENTERS_PER_DAY - 1; i++) {
    assert.equal(maybeRecenter(ctx, 800 + i, 100), true);
  }
  assert.equal(maybeRecenter(ctx, 900, 100), false);
  assert.equal(used.get('recenter'), MAX_RECENTERS_PER_DAY);
});

test('stale re-center: the new grid is symmetric around price and fully re-armed', () => {
  const { ctx, store } = liveGrid();
  assert.equal(staleBranch(ctx, store, LIVE_PRICE, NOW), true);

  const center = store.get('center') as number;
  const levels = computeLevels(center);
  const byKey = new Map(levels.map((l) => [l.key, l]));
  approx(byKey.get('buy:1')!.price, 694.425, 1e-9);
  approx(byKey.get('sell:1')!.price, 715.575, 1e-9);
  for (let i = 1; i <= 4; i++) {
    approx(byKey.get(`sell:${i}`)!.price - center, center - byKey.get(`buy:${i}`)!.price, 1e-9);
    approx(byKey.get(`sell:${i}`)!.price - center, center * GRID_SPACING * i, 1e-9);
  }

  // Previously marked levels are re-armed: buy:1 can fire again once price
  // moves 1.5 percent down, where before it was marked forever.
  const crossed = store.get('crossedLevels') as string[];
  assert.deepEqual(crossed, []);
  assert.equal(detectCrossing(LIVE_PRICE, 694, levels, crossed)?.level.key, 'buy:1');
  assert.equal(detectCrossing(LIVE_PRICE, 716, levels, crossed)?.level.key, 'sell:1');

  // And it does not immediately re-fire at the new center, nor read as stale
  // again on the next tick, so it cannot loop through the daily budget.
  assert.equal(detectCrossing(LIVE_PRICE, LIVE_PRICE, levels, crossed), null);
  assert.equal(isGridStale(NOW, NOW - THREE_DAYS_MS, LIVE_PRICE, center), false);
});

test('STALE_RECENTER_MS is 12 hours and far exceeds the cooldown and tick', () => {
  assert.equal(STALE_RECENTER_MS, 12 * 60 * 60_000);
  assert.ok(STALE_RECENTER_MS > COOLDOWN_MS * 10, 'a merely quiet session must not trip it');
});

test('maybeRecenter still defaults to the breakout reason', () => {
  const { ctx, store, logs } = fakeGridCtx(() => true);
  store.set('center', 600);
  assert.equal(maybeRecenter(ctx, 720, 850), true);
  assert.equal(logs.at(-1)!.reason, 'breakout');
  assert.equal(logs.at(-1)!.previousCenter, 600);
});
