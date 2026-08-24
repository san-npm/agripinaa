/**
 * grid-b is the second agent in the grid category. Its value is that it is
 * NOT the first one: a hub with two identical agents is still one listing. So
 * these tests pin three things.
 *
 * 1. The parameters really differ from `grid`, field by field. A copied
 *    constant would make the comparison the hub offers meaningless.
 * 2. The ladder geometry holds at those parameters (symmetric, monotonic,
 *    straddling the center).
 * 3. The manifest's safety block is the same numbers the tick enforces. That
 *    body is served at the URL an ERC-8004 tokenURI will point at, so a cap
 *    published there and not applied in code would be a false claim about how
 *    the agent behaves with someone's capital.
 *
 * The tick tests drive the real module through a fake context, the way
 * lp-range.test.ts does, so the wiring (init, breakout, guards, clip sizing)
 * is exercised rather than only the arithmetic underneath it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';

import { GRID_B_PARAMS, buildLadder, gridBAgent } from '../src/agents/grid-b';
import {
  CLIP_USD,
  COOLDOWN_MS,
  GRID_LEVELS_PER_SIDE,
  GRID_SPACING,
  MAX_TRADES_PER_DAY,
} from '../src/agents/grid';
import type { AgentContext } from '../src/types';

const WBNB = TOKENS_BSC['WBNB']!;
const USDC = TOKENS_BSC['USDC']!;

const approx = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );

/* ------------------------------- parameters ------------------------------ */

test('grid-b runs a different pair and a wider ladder than grid', () => {
  assert.notEqual(GRID_B_PARAMS.pair, 'WBNB/USDT');
  assert.equal(GRID_B_PARAMS.pair, 'WBNB/USDC');
  assert.ok(GRID_B_PARAMS.spacingPct > 1.5, 'wider spacing than grid');
  assert.ok(GRID_B_PARAMS.levelsPerSide >= 4);
});

test('every parameter that defines the strategy differs from grid', () => {
  // Field by field, because "a second agent" that shares grid's numbers on a
  // second pair is a duplicate listing, not a comparison.
  assert.notEqual(GRID_B_PARAMS.spacingPct * 0.01, GRID_SPACING);
  assert.equal(GRID_B_PARAMS.spacingPct / 100, 0.025);
  assert.ok(GRID_B_PARAMS.spacingPct / 100 > GRID_SPACING, 'spacing must be wider');
  assert.ok(GRID_B_PARAMS.levelsPerSide > GRID_LEVELS_PER_SIDE, 'more levels per side');
  assert.ok(GRID_B_PARAMS.clipUsd < CLIP_USD, 'smaller clips');
  assert.ok(GRID_B_PARAMS.maxTradesPerDay < MAX_TRADES_PER_DAY, 'lower daily cap');
  assert.ok(GRID_B_PARAMS.cooldownMs > COOLDOWN_MS, 'longer cooldown');
  assert.equal(GRID_B_PARAMS.cooldownMs, 45 * 60_000);
});

test('the cooldown still outlasts an Ophis order, so clips cannot overlap', () => {
  // The reason grid's cooldown is 31 minutes: a CoW order stays executable for
  // about 30. A shorter cooldown lets a second clip be signed while the first
  // can still fill, against balance neither reserved.
  assert.ok(GRID_B_PARAMS.cooldownMs > 30 * 60_000);
});

test('a full day of trading at the cap cannot outrun the cooldown', () => {
  // 8 trades spaced 45 minutes apart is 6 hours, comfortably inside a day, so
  // the daily cap is a real ceiling rather than one the cooldown makes moot.
  assert.ok(GRID_B_PARAMS.maxTradesPerDay * GRID_B_PARAMS.cooldownMs < 24 * 3_600_000);
});

/* --------------------------------- ladder -------------------------------- */

test('ladder is symmetric around mid and monotonic', () => {
  const ladder = buildLadder(100, GRID_B_PARAMS);
  assert.equal(ladder.buys.length, GRID_B_PARAMS.levelsPerSide);
  assert.equal(ladder.sells.length, GRID_B_PARAMS.levelsPerSide);
  assert.ok(ladder.buys.every((p, i) => i === 0 || p < ladder.buys[i - 1]!));
  assert.ok(ladder.sells.every((p, i) => i === 0 || p > ladder.sells[i - 1]!));
  assert.ok(ladder.buys[0]! < 100 && ladder.sells[0]! > 100);
});

test('ladder rungs sit exactly 2.5 percent apart, mirrored either side', () => {
  const center = 640;
  const { buys, sells } = buildLadder(center, GRID_B_PARAMS);
  for (let i = 0; i < GRID_B_PARAMS.levelsPerSide; i++) {
    const step = center * 0.025 * (i + 1);
    approx(sells[i]! - center, step, 1e-9);
    approx(center - buys[i]!, step, 1e-9);
  }
  // The outermost rung is 12.5 percent out, well past the 6 percent breakout
  // band, so the two farthest levels only ever trade after a re-center.
  approx(sells.at(-1)!, center * 1.125, 1e-9);
});

/* ------------------------- manifest matches the code --------------------- */

test('the published safety caps are the ones the tick enforces', () => {
  const { safety } = AGENTS['grid-b'].manifest;
  assert.equal(safety['maxTradesPerDay'], GRID_B_PARAMS.maxTradesPerDay);
  assert.equal(safety['perTradeClipUsd'], GRID_B_PARAMS.clipUsd);
  assert.equal(safety['minTradeClipUsd'], GRID_B_PARAMS.minClipUsd);
  assert.equal(safety['gridSpacingPct'], GRID_B_PARAMS.spacingPct);
  assert.equal(safety['levelsPerSide'], GRID_B_PARAMS.levelsPerSide);
  assert.equal(safety['cooldownMinutes'], GRID_B_PARAMS.cooldownMs / 60_000);
  assert.equal(safety['trendHaltBandPct'], GRID_B_PARAMS.trendHaltBandPct);
  assert.equal(safety['lossHaltPct'], GRID_B_PARAMS.lossHaltPct);
  assert.equal(safety['maxRecentersPerDay'], GRID_B_PARAMS.maxRecentersPerDay);
});

test('the manifest says what a breach actually does, not just where it sits', () => {
  // The drawdown baseline is written once and never reset, and the halt it
  // trips needs a human. Both are surprising enough to belong in the served
  // manifest rather than only in the code.
  const { safety, execution } = AGENTS['grid-b'].manifest;
  assert.match(String(safety['lossHaltBaseline']), /never re-baselined/);
  assert.match(String(safety['onHalt']), /operator/);
  assert.equal(execution.pair, GRID_B_PARAMS.pair);
  assert.equal(execution.venue, 'ophis');
  assert.equal(execution.chainId, 56);
});

test('the registry record is configuration only until it is registered', () => {
  const record = AGENTS['grid-b'];
  assert.equal(record.tokenId, null);
  assert.equal(record.wallet, null);
  assert.equal(record.registrationTx, null);
  assert.equal(record.attestation, null);
  assert.deepEqual(record.proofs, []);
  assert.equal(record.managed, false);
  // The buy leg spends the quote token, so the funded stablecoin has to be the
  // one on the pair or every buy blocks on an empty balance.
  assert.equal(record.funding.usdc, '2');
  assert.equal(record.funding.usdt, undefined);
});

/* ---------------------------------- tick --------------------------------- */

/* The deepest WBNB/USDC PancakeSwap V3 pool on BSC, probed 2026-08-24: fee tier
 * 100 holding 632 WBNB against 1,488,399 USDC. The agent still resolves it
 * through the factory at runtime; these values only make the fake chain
 * realistic. */
const POOL = '0xf2688Fb5B81049DFB7703aDa5e770543770612C4';
const CENTER = 640;

interface GridBFakeOpts {
  /** Mid price the pool reports; the fake returns it through slot0. */
  price: number;
  wbnbWei?: bigint;
  usdcWei?: bigint;
  allowAction?: (kind: string, maxPerDay: number) => boolean;
  initialState?: Record<string, unknown>;
}

/**
 * A fake chain just deep enough for the tick: the factory answers one pool, the
 * pool reports liquidity and a slot0 whose sqrt price decodes back to the price
 * under test, and balances come from the options. A swap attempt is recorded
 * and then stopped at the decimals read, which is the point of no return into
 * the real orderbook client.
 */
function fakeCtx(opts: GridBFakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
  swapAttempts: string[];
  halts: string[];
} {
  const store = new Map<string, unknown>(Object.entries(opts.initialState ?? {}));
  const logs: Record<string, unknown>[] = [];
  const swapAttempts: string[] = [];
  const halts: string[] = [];
  /* USDC is token1 here, so sqrtPriceX96 = sqrt(price) * 2^96. */
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(opts.price) * 2 ** 96));

  const publicClient = {
    async readContract(call: { address: string; functionName: string; args?: unknown[] }) {
      const { address, functionName, args } = call;
      if (functionName === 'decimals') {
        swapAttempts.push(address.toLowerCase());
        return Promise.reject(new Error('test stub: swap stopped before the orderbook'));
      }
      if (functionName === 'getPool') {
        return (args![2] as number) === 100 ? POOL : '0x0000000000000000000000000000000000000000';
      }
      if (functionName === 'token0') return WBNB.address;
      if (functionName === 'token1') return USDC.address;
      if (functionName === 'fee') return 100;
      if (functionName === 'liquidity') return BigInt('632000000000000000000');
      if (functionName === 'slot0') return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
      if (functionName === 'balanceOf') {
        return address.toLowerCase() === WBNB.address.toLowerCase()
          ? (opts.wbnbWei ?? BigInt(0))
          : (opts.usdcWei ?? BigInt(0));
      }
      throw new Error(`unexpected read ${functionName}@${address}`);
    },
  };

  const ctx = {
    name: 'grid-b',
    chainId: 56,
    account: { address: '0x000000000000000000000000000000000000dEaD' },
    publicClient,
    walletClient: { chain: { id: 56 } },
    log: (e: Record<string, unknown>) => logs.push(e),
    state: {
      get<T>(key: string, fallback: T): T {
        return (store.has(key) ? store.get(key) : fallback) as T;
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
    breakers: {
      halt: (reason: string) => halts.push(reason),
      isHalted: () => ({ halted: false }),
      allowAction: (kind: string, maxPerDay: number) =>
        opts.allowAction ? opts.allowAction(kind, maxPerDay) : true,
    },
  } as unknown as AgentContext;
  return { ctx, logs, store, swapAttempts, halts };
}

const funded = {
  wbnbWei: toBaseUnits('0.01', WBNB.decimals),
  usdcWei: toBaseUnits('6', USDC.decimals),
};

test('module export matches the chassis contract', () => {
  assert.equal(gridBAgent.name, 'grid-b');
  assert.equal(gridBAgent.category, 'grid');
  assert.equal(typeof gridBAgent.tick, 'function');
  assert.equal(typeof gridBAgent.status, 'function');
  assert.ok(gridBAgent.tickIntervalMs > 0);
});

test('first tick resolves the pool through the factory and arms the ladder', async () => {
  const { ctx, logs, store } = fakeCtx({ price: CENTER, ...funded });
  await gridBAgent.tick(ctx);

  const selected = logs.find((l) => l.event === 'pool-selected');
  assert.ok(selected, 'the pool must be resolved through the factory, never hardcoded');
  assert.equal(selected!['address'], POOL);
  assert.equal(selected!['fee'], 100);

  const init = logs.find((l) => l.event === 'grid-init');
  assert.ok(init, `expected grid-init, got ${JSON.stringify(logs.map((l) => l.event))}`);
  approx(store.get('center') as number, CENTER, 0.01);
  // Baseline written before the center, so a crash can never leave a center
  // with the drawdown floor disabled.
  assert.ok((store.get('inventoryStartUsd') as number) > 0);
});

test('a price inside the first rung does nothing at all', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    price: CENTER * 1.02, // 2 percent, inside the 2.5 percent step
    ...funded,
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 12 },
  });
  await gridBAgent.tick(ctx);
  assert.equal(logs.at(-1)!.event, 'tick');
  assert.deepEqual(swapAttempts, []);
});

test('crossing the first sell rung submits one clip, sized in WBNB', async () => {
  const { ctx, logs, store, swapAttempts } = fakeCtx({
    price: CENTER * 1.03, // past sell:1 at +2.5 percent, short of sell:2
    ...funded,
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 12 },
  });
  await gridBAgent.tick(ctx).catch(() => {
    /* the fake chain stops the swap at the decimals read */
  });

  const intent = logs.find((l) => l.event === 'trade-intent');
  assert.ok(intent, `expected a trade-intent, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(intent!['side'], 'sell');
  assert.equal(intent!['level'], 'sell:1');
  assert.equal(intent!['sellToken'], WBNB.address);
  assert.equal(intent!['buyToken'], USDC.address);
  // $1.50 of WBNB at ~659 USDC, not grid's $2.
  approx(Number(intent!['sellAmount']), GRID_B_PARAMS.clipUsd / (CENTER * 1.03), 1e-6);
  assert.deepEqual(swapAttempts, [WBNB.address.toLowerCase()]);
  // Cooldown anchor and level mark persist BEFORE the submit, so a crash in
  // the submit window cannot re-fire the same clip.
  assert.deepEqual(store.get('crossedLevels'), ['sell:1']);
  assert.ok(typeof store.get('lastFillAt') === 'number');
});

test('the same crossing is blocked while the 45 minute cooldown is running', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    price: CENTER * 1.03,
    ...funded,
    initialState: {
      center: CENTER,
      lastPrice: CENTER,
      inventoryStartUsd: 12,
      lastFillAt: Date.now() - 40 * 60_000,
    },
  });
  await gridBAgent.tick(ctx);
  const blocked = logs.find((l) => l.event === 'trade-blocked');
  assert.ok(blocked);
  assert.equal(blocked!['reason'], 'cooldown');
  assert.deepEqual(swapAttempts, [], 'nothing may be submitted during cooldown');
});

test('an empty quote leg blocks a buy instead of quoting an unfundable clip', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    price: CENTER * 0.97, // past buy:1
    wbnbWei: toBaseUnits('0.01', WBNB.decimals),
    usdcWei: BigInt(0),
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 6 },
  });
  await gridBAgent.tick(ctx);
  const blocked = logs.find((l) => l.event === 'trade-blocked');
  assert.ok(blocked);
  assert.equal(blocked!['reason'], 'insufficient-balance');
  assert.deepEqual(swapAttempts, []);
});

test('a partly funded leg shrinks the clip rather than stranding the capital', async () => {
  // The failure this rule exists for: grid sat 0.4 cents short of a fixed clip
  // and refused 1,559 crossings in a row.
  const { ctx, logs } = fakeCtx({
    price: CENTER * 0.97,
    wbnbWei: toBaseUnits('0.01', WBNB.decimals),
    usdcWei: toBaseUnits('1.2', USDC.decimals),
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 7 },
  });
  await gridBAgent.tick(ctx).catch(() => {});
  const intent = logs.find((l) => l.event === 'trade-intent');
  assert.ok(intent, `expected a trade-intent, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(intent!['sellAmount'], '1.2');
  assert.equal(intent!['desiredClipUsd'], GRID_B_PARAMS.clipUsd);
  approx(Number(intent!['effectiveClipUsd']), 1.2, 1e-9);
});

test('a breakout needs two ticks, then re-centers within the daily budget', async () => {
  const state = { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 12 };
  const first = fakeCtx({ price: CENTER * 1.08, ...funded, initialState: state });
  await gridBAgent.tick(first.ctx);
  assert.equal(first.logs.at(-1)!.event, 'breakout-observed');
  assert.equal(first.store.get('center'), CENTER, 'a single spike must not re-arm the ladder');

  const second = fakeCtx({
    price: CENTER * 1.08,
    ...funded,
    initialState: { ...state, breakoutStreak: 1 },
  });
  await gridBAgent.tick(second.ctx);
  const recenter = second.logs.find((l) => l.event === 'grid-recenter');
  assert.ok(recenter);
  assert.equal(recenter!['reason'], 'breakout');
  approx(second.store.get('center') as number, CENTER * 1.08, 0.01);
  // The drawdown floor stays anchored to the original baseline.
  assert.equal(second.store.get('inventoryStartUsd'), 12);
});

test('a breakout past the re-center budget halts, and the halt is permanent', async () => {
  const { ctx, logs, store, halts } = fakeCtx({
    price: CENTER * 1.08,
    ...funded,
    allowAction: (kind) => kind !== 'recenter',
    initialState: {
      center: CENTER,
      lastPrice: CENTER,
      inventoryStartUsd: 12,
      breakoutStreak: 1,
    },
  });
  await gridBAgent.tick(ctx);
  assert.deepEqual(halts, ['trend-breakout']);
  assert.equal(logs.at(-1)!.event, 'trend-breakout');
  assert.equal(store.get('center'), CENTER);
});

test('a 5 percent drawdown halts before any adaptation, breakout included', async () => {
  const { ctx, logs, halts } = fakeCtx({
    price: CENTER * 1.08, // also a breakout: the loss must still win
    wbnbWei: toBaseUnits('0.005', WBNB.decimals),
    usdcWei: BigInt(0),
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 100 },
  });
  await gridBAgent.tick(ctx);
  assert.deepEqual(halts, ['daily-loss'], 'capital protection outranks re-centering');
  assert.equal(logs.at(-1)!.event, 'daily-loss');
});

test('a center with no drawdown baseline fails closed', async () => {
  const { ctx, halts } = fakeCtx({
    price: CENTER,
    ...funded,
    initialState: { center: CENTER, lastPrice: CENTER },
  });
  await gridBAgent.tick(ctx);
  assert.deepEqual(halts, ['state-incomplete']);
});

test('status reports the ladder and the parameters it is running', async () => {
  const { ctx } = fakeCtx({
    price: CENTER,
    ...funded,
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 12, crossedLevels: ['buy:1'] },
  });
  const status = (await gridBAgent.status(ctx)) as {
    pair: string;
    levels: { price: number; side: string; crossed: boolean }[];
    params: typeof GRID_B_PARAMS;
  };
  assert.equal(status.pair, 'WBNB/USDC');
  assert.equal(status.levels.length, GRID_B_PARAMS.levelsPerSide * 2);
  assert.equal(status.params.maxTradesPerDay, GRID_B_PARAMS.maxTradesPerDay);
});
