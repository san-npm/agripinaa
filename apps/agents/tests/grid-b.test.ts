/**
 * grid-b is the second agent in the grid category. Its value is that it is
 * NOT the first one: a hub with two identical agents is still one listing. So
 * these tests pin four things.
 *
 * 1. The market differs from `grid` in substance. Not just the quote token: an agent
 *    running WBNB/USDC alongside grid's WBNB/USDT is the same BNB price action
 *    priced in a second dollar, so the two track records would move together
 *    and the hub would be listing one strategy twice. BTCB is a different
 *    asset, and the base symbol is what these tests hold.
 * 2. The parameters differ too, field by field. A copied constant would
 *    make the comparison the hub offers meaningless.
 * 3. The ladder geometry and the clip arithmetic hold at those parameters and
 *    at this pair's magnitudes. BTCB costs about 80,000 USDT a coin, roughly a
 *    hundred and twenty times WBNB, so every clip the agent quotes is a much
 *    smaller number of base units than the one `grid` quotes.
 * 4. The manifest's safety block is the same numbers the tick enforces. That
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
import {
  clipForLevel,
  effectiveClipUsd,
  evaluateGuards,
  lossFloorOf,
  trendBandOf,
} from '../src/grid-core';
import type { GuardInput } from '../src/grid-core';
import type { AgentContext } from '../src/types';

const BTCB = TOKENS_BSC['BTCB']!;
const USDT = TOKENS_BSC['USDT']!;

/**
 * Roughly the USDT-per-BTCB price the fee-500 pool reported on 2026-08-25. The
 * exact figure is not what any assertion rests on; what matters is that it is a
 * five-figure unit price, because that is what stresses the clip arithmetic.
 */
const CENTER = 80630;

/**
 * The clip symbols, derived from the shipped pair rather than transcribed, so
 * this file cannot drift from the module it is testing. The tick tests below
 * pin the same split independently: a trade-intent names BTCB.address as the
 * sell token, and the balance guard reads the leg clip.token selects.
 */
const [BASE_SYMBOL, QUOTE_SYMBOL] = GRID_B_PARAMS.pair.split('/') as ['BTCB', 'USDT'];
const CLIP_SYMBOLS = { base: BASE_SYMBOL, quote: QUOTE_SYMBOL };

const approx = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );

/* ------------------------------- parameters ------------------------------ */

test('grid-b runs a different market and a wider ladder than grid', () => {
  assert.notEqual(GRID_B_PARAMS.pair, 'WBNB/USDT');
  assert.equal(GRID_B_PARAMS.pair, 'BTCB/USDT');
  // The BASE asset is what makes this a second market rather than a second
  // ticker on the first one. A WBNB base against any dollar would track grid's
  // book move for move.
  assert.notEqual(BASE_SYMBOL, 'WBNB');
  assert.equal(BASE_SYMBOL, BTCB.symbol);
  // The quote stays a dollar stablecoin, which is not cosmetic: inventoryValueUsd
  // sums base * price + quote and calls the result dollars, and the drawdown
  // halt and the clip sizing both rest on that reading.
  assert.equal(QUOTE_SYMBOL, USDT.symbol);
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
  const { buys, sells } = buildLadder(CENTER, GRID_B_PARAMS);
  // 1e-6 on a number near 80,000 is a relative tolerance of about 1e-11, which
  // is still four orders tighter than the smallest spacing error worth naming
  // and leaves room for float cancellation at this magnitude.
  for (let i = 0; i < GRID_B_PARAMS.levelsPerSide; i++) {
    const step = CENTER * 0.025 * (i + 1);
    approx(sells[i]! - CENTER, step, 1e-6);
    approx(CENTER - buys[i]!, step, 1e-6);
  }
  // The outermost rung is 12.5 percent out, well past the 6 percent breakout
  // band, so the two farthest levels only ever trade after a re-center.
  approx(sells.at(-1)!, CENTER * 1.125, 1e-6);
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
});

test('the funding plan holds both legs of the pair and nothing else', () => {
  // A grid spends both sides, so both have to arrive: the buy side sells the
  // quote and the sell side sells the base. A leg funded in a token that is not
  // on the pair leaves that whole direction blocked on an empty balance while
  // the money sits somewhere the agent never reaches, which is exactly what a
  // USDT budget would have done to the old USDC-quoted version of this agent.
  const { funding } = AGENTS['grid-b'];
  assert.equal(funding.usdt, '2');
  assert.equal(funding.btcb, '0.000025');
  assert.equal(funding.usdc, undefined, 'USDC is no longer on this pair');
  assert.equal(funding.wbnb, undefined, 'WBNB is no longer on this pair');

  // Both legs have to clear one clip, or the agent arrives funded on paper and
  // blocked on its first crossing in that direction. BTCB is the one worth
  // checking: 0.000025 of a coin reads like dust until it is priced.
  assert.ok(
    Number(funding.btcb) * CENTER >= GRID_B_PARAMS.clipUsd,
    `the BTCB leg is worth ${Number(funding.btcb) * CENTER} USD, under one clip`,
  );
  assert.ok(Number(funding.usdt) >= GRID_B_PARAMS.clipUsd, 'the USDT leg must clear one clip');
});

/* ----------------- clip sizing at a five-figure unit price ---------------- */

/**
 * A guard input with everything passing, so a test can vary one field and read
 * the result as a statement about that field alone.
 */
function guardInput(overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    nowMs: 0,
    lastFillAtMs: null,
    price: CENTER,
    center: CENTER,
    inventoryNowUsd: 100,
    inventoryStartUsd: 100,
    clipBaseUnits: BigInt(0),
    balanceBaseUnits: BigInt(0),
    allowTrade: () => true,
    cooldownMs: GRID_B_PARAMS.cooldownMs,
    maxDeviation: trendBandOf(GRID_B_PARAMS),
    lossFloor: lossFloorOf(GRID_B_PARAMS),
    ...overrides,
  };
}

test('a $1.50 clip is representable at BTCB unit prices, floor included', () => {
  // clipForLevel quotes a sell in base units to 6 significant figures. On WBNB
  // that is a number like 0.0021; on a coin worth 80,000 USDT the same clip is
  // five orders smaller, so the question is whether 6 figures still say
  // anything here.
  const clip = clipForLevel('sell', CENTER, GRID_B_PARAMS.clipUsd, CLIP_SYMBOLS);
  assert.equal(clip.token, 'BTCB');
  assert.equal(clip.amount, '0.0000186035');
  // Ten decimal places against BTCB's eighteen: the quote lands on a whole
  // number of base units with eight decimals to spare, so nothing is truncated
  // on the way to the orderbook and no clip can round to zero.
  assert.equal(toBaseUnits(clip.amount, BTCB.decimals), BigInt('18603500000000'));
  // The rounding costs about a millionth of the notional, orders of magnitude
  // under the 100 bps of slippage the swap already allows.
  const exact = GRID_B_PARAMS.clipUsd / CENTER;
  assert.ok(Math.abs(Number(clip.amount) - exact) / exact < 1e-6);

  // The floor matters more than the desired size, because it is the smallest
  // clip this agent will ever quote. It is still a ten-decimal number rather
  // than a handful of base units.
  const floor = clipForLevel('sell', CENTER, GRID_B_PARAMS.minClipUsd, CLIP_SYMBOLS);
  assert.equal(floor.amount, '0.0000124023');
  assert.ok(toBaseUnits(floor.amount, BTCB.decimals) > BigInt(1_000_000_000_000));
});

test('a reduced sell clip rounds inside the balance or blocks, never over it', () => {
  /*
   * A sell clip reduced to the whole balance is quoted as that balance in BTCB
   * rounded to 6 significant figures, and a wallet balance carries far more
   * figures than that, so the quote lands a hair ABOVE the balance about half
   * the time and the crossing is blocked. That is a property of the 6-figure
   * quote and not of this pair: the same sweep run at grid's WBNB price and $2
   * clip blocks at the same rate with the same bound. It is safe in one
   * direction only, and this is the direction: the balance guard turns the
   * overshoot into a blocked crossing that the next tick re-reads and retries.
   * What must never happen is a clip above the balance that the guard passes.
   */
  let blocked = 0;
  let fitted = 0;
  const lo = GRID_B_PARAMS.minClipUsd / CENTER;
  const hi = GRID_B_PARAMS.clipUsd / CENTER;
  for (let i = 0; i <= 400; i++) {
    // toFixed(18) so the balance is an exact number of base units with more
    // significant figures than the quote can carry, which is what a live wallet
    // holds and what makes the rounding bite.
    const balance = (lo + (i / 400) * (hi - lo)).toFixed(18);
    const clipUsd = effectiveClipUsd(
      GRID_B_PARAMS.clipUsd,
      Number(balance) * CENTER,
      GRID_B_PARAMS.minClipUsd,
    );
    if (clipUsd === 0) continue;
    const clip = clipForLevel('sell', CENTER, clipUsd, CLIP_SYMBOLS);
    const clipBaseUnits = toBaseUnits(clip.amount, BTCB.decimals);
    const balanceBaseUnits = toBaseUnits(balance, BTCB.decimals);
    const guard = evaluateGuards(guardInput({ clipBaseUnits, balanceBaseUnits }));

    if (clipBaseUnits > balanceBaseUnits) {
      blocked++;
      assert.deepEqual(
        guard,
        { ok: false, reason: 'insufficient-balance', halt: false },
        `clip ${clip.amount} exceeds balance ${balance} and must never pass the guard`,
      );
      // A hair, not a funding gap: the overshoot is bounded by the sixth
      // significant figure, so a block here is rounding rather than a wallet
      // that is short.
      assert.ok(
        Number(clipBaseUnits - balanceBaseUnits) / Number(balanceBaseUnits) < 1e-5,
        `overshoot on ${clip.amount} against ${balance} is larger than the rounding can explain`,
      );
    } else {
      fitted++;
      assert.deepEqual(guard, { ok: true });
    }
  }
  assert.ok(
    fitted > 0 && blocked > 0,
    `expected both outcomes across the sweep, got ${fitted} fitted and ${blocked} blocked`,
  );
});

/* ---------------------------------- tick --------------------------------- */

/*
 * The three BTCB/USDT PancakeSwap V3 pools the factory answers for, probed
 * on-chain 2026-08-25 against https://bsc-rpc.publicnode.com. liquidity() is
 * the measured value; fee 500 is deeper than the other two by more than an
 * order of magnitude (its book held about 9.9 million USDT against 81 BTCB,
 * where fee 100 held 527,000 USDT and fee 2500 held 2,750), so the fake gives
 * the depth selection something to choose between rather than the single
 * candidate a one-pool stub would hand it. The agent still resolves this through the
 * factory at runtime; nothing here is hardcoded in the module.
 */
const POOLS: Record<number, { address: `0x${string}`; liquidity: bigint }> = {
  100: {
    address: '0x247f51881d1E3aE0f759AFB801413a6C948Ef442',
    liquidity: BigInt('8951587470556786452713'),
  },
  500: {
    address: '0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4',
    liquidity: BigInt('426535459508013114904779'),
  },
  2500: {
    address: '0x6ee3eE9C3395BbD136B6076A70Cb6cFF241c0E24',
    liquidity: BigInt('31028514157404233206'),
  },
};
const POOL = POOLS[500]!.address;
const POOL_BY_ADDRESS = new Map(
  Object.entries(POOLS).map(([fee, pool]) => [
    pool.address.toLowerCase(),
    { fee: Number(fee), liquidity: pool.liquidity },
  ]),
);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface GridBFakeOpts {
  /** Mid price the pool reports; the fake returns it through slot0. */
  price: number;
  btcbWei?: bigint;
  usdtWei?: bigint;
  allowAction?: (kind: string, maxPerDay: number) => boolean;
  initialState?: Record<string, unknown>;
}

/**
 * A fake chain just deep enough for the tick: the factory answers three pools,
 * each reports its own fee and its measured liquidity, the selected one reports
 * a slot0 whose sqrt price decodes back to the price under test, and balances
 * come from the options. A swap attempt is recorded and then stopped at the
 * decimals read, which is the point of no return into the real orderbook client.
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
  /*
   * USDT 0x55d3... sorts BELOW BTCB 0x7130..., so on every one of these pools
   * USDT is token0 and the BASE token is token1. That is the reverse of the
   * WBNB/USDC book this agent used to read, and it is the one thing a fixture
   * cannot fudge: resolveReferencePool sets wbnbIsToken0 (read it as "the base
   * token is token0") to FALSE, and priceFromSqrtPriceX96 then returns the
   * RECIPROCAL of the raw slot0 ratio. So the ratio encoded here is BTCB per
   * USDT, not USDT per BTCB. Encoding sqrt(price) the way the old fixture did
   * would decode to about 1/80,000 and quietly turn every assertion below into
   * a comparison against a reciprocal.
   */
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(1 / opts.price) * 2 ** 96));

  const publicClient = {
    async readContract(call: { address: string; functionName: string; args?: unknown[] }) {
      const { address, functionName, args } = call;
      if (functionName === 'decimals') {
        swapAttempts.push(address.toLowerCase());
        return Promise.reject(new Error('test stub: swap stopped before the orderbook'));
      }
      if (functionName === 'getPool') {
        return POOLS[args![2] as number]?.address ?? ZERO_ADDRESS;
      }
      if (functionName === 'balanceOf') {
        return address.toLowerCase() === BTCB.address.toLowerCase()
          ? (opts.btcbWei ?? BigInt(0))
          : (opts.usdtWei ?? BigInt(0));
      }
      // All three pools carry the same ordering, so token0/token1 are constant
      // while fee and liquidity are per pool.
      if (functionName === 'token0') return USDT.address;
      if (functionName === 'token1') return BTCB.address;
      const pool = POOL_BY_ADDRESS.get(address.toLowerCase());
      if (functionName === 'fee') return pool!.fee;
      if (functionName === 'liquidity') return pool!.liquidity;
      if (functionName === 'slot0') return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
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

/*
 * About $6.45 of BTCB against $6 of USDT at CENTER, which is the same dollar
 * shape the old WBNB/USDC fixture carried, so every inventoryStartUsd below
 * still sits where it did relative to the 5 percent drawdown floor. In BTCB
 * that dollar leg is a small number: 0.00008 of a coin, four clips of headroom
 * over the $1.50 size (one clip being about 0.0000186 BTCB).
 */
const funded = {
  btcbWei: toBaseUnits('0.00008', BTCB.decimals),
  usdtWei: toBaseUnits('6', USDT.decimals),
};

test('module export matches the chassis contract', () => {
  assert.equal(gridBAgent.name, 'grid-b');
  assert.equal(gridBAgent.category, 'grid');
  assert.equal(typeof gridBAgent.tick, 'function');
  assert.equal(typeof gridBAgent.status, 'function');
  assert.ok(gridBAgent.tickIntervalMs > 0);
});

test('first tick arms the ladder on the deepest tier, price read the right way up', async () => {
  const { ctx, logs, store } = fakeCtx({ price: CENTER, ...funded });
  await gridBAgent.tick(ctx);

  const probes = logs.filter((l) => l.event === 'pool-probe');
  assert.equal(probes.length, 3, 'every eligible tier is probed, not just the first that answers');

  const selected = logs.find((l) => l.event === 'pool-selected');
  assert.ok(selected, 'the pool must be resolved through the factory, never hardcoded');
  assert.equal(selected!['address'], POOL);
  // Fee 500, where `grid` lands on fee 100: the deepest tier is a property of
  // the book, so a second pair does not inherit the first pair's answer.
  assert.equal(selected!['fee'], 500);
  // The base token is token1 on this pair. If this ever reads true the decode
  // has inverted and every level, halt band and drawdown floor would be
  // measured against a reciprocal.
  assert.equal(selected!['wbnbIsToken0'], false);

  const init = logs.find((l) => l.event === 'grid-init');
  assert.ok(init, `expected grid-init, got ${JSON.stringify(logs.map((l) => l.event))}`);
  // An inverted decode would store about 0.0000124 here rather than 80,630, so
  // this tolerance is the orientation check as much as a precision one.
  approx(store.get('center') as number, CENTER, 0.001);
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

test('crossing the first sell rung submits one clip, sized in BTCB', async () => {
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
  assert.equal(intent!['sellToken'], BTCB.address);
  assert.equal(intent!['buyToken'], USDT.address);
  // $1.50 of BTCB at about 83,049 USDT, not grid's $2 of WBNB. Pinned as the
  // literal string the orderbook would receive, because the magnitude is the
  // whole point: ten decimal places, six significant figures.
  assert.equal(intent!['sellAmount'], '0.0000180616');
  approx(Number(intent!['sellAmount']), GRID_B_PARAMS.clipUsd / (CENTER * 1.03), 1e-10);
  assert.deepEqual(swapAttempts, [BTCB.address.toLowerCase()]);
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
    btcbWei: toBaseUnits('0.00008', BTCB.decimals),
    usdtWei: BigInt(0),
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
  // and refused 1,559 crossings in a row. 1.2 USDT is under the $1.50 clip and
  // over the $1 floor, so the clip has to shrink to it rather than block.
  const { ctx, logs } = fakeCtx({
    price: CENTER * 0.97,
    btcbWei: toBaseUnits('0.00008', BTCB.decimals),
    usdtWei: toBaseUnits('1.2', USDT.decimals),
    initialState: { center: CENTER, lastPrice: CENTER, inventoryStartUsd: 7 },
  });
  await gridBAgent.tick(ctx).catch(() => {});
  const intent = logs.find((l) => l.event === 'trade-intent');
  assert.ok(intent, `expected a trade-intent, got ${JSON.stringify(logs.map((l) => l.event))}`);
  // A buy spends the quote, so the clip is quoted in USDT and the unit price of
  // the base never enters it.
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
  approx(second.store.get('center') as number, CENTER * 1.08, 0.001);
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
    // Half the funded base leg and nothing in the quote: about $3.48 against a
    // $100 baseline, well under the 5 percent floor.
    btcbWei: toBaseUnits('0.00004', BTCB.decimals),
    usdtWei: BigInt(0),
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
    initialState: {
      center: CENTER,
      lastPrice: CENTER,
      inventoryStartUsd: 12,
      crossedLevels: ['buy:1'],
    },
  });
  const status = (await gridBAgent.status(ctx)) as {
    pair: string;
    levels: { price: number; side: string; crossed: boolean }[];
    params: typeof GRID_B_PARAMS;
  };
  assert.equal(status.pair, 'BTCB/USDT');
  assert.equal(status.levels.length, GRID_B_PARAMS.levelsPerSide * 2);
  assert.equal(status.params.maxTradesPerDay, GRID_B_PARAMS.maxTradesPerDay);
});
