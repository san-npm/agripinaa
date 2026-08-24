import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC } from '@agripinaa/shared';

import {
  DAY_MS,
  MAX_REBALANCES_PER_WEEK,
  MIN_MINT_LEG_USD,
  MINTED_HISTORY_LIMIT,
  OUT_OF_RANGE_EXIT_MS,
  WEEK_MS,
  computeRebalanceLeg,
  formatWholeUnits,
  isInRange,
  lpRangeAgent,
  needsCollect,
  needsInventoryPrep,
  needsReentry,
  nextOutSince,
  pctToTickDelta,
  pruneWindow,
  rememberTokenId,
  shouldRebalance,
  snapRange,
  sqrtPriceX96ToUsdtPerWbnb,
  weeklyBudget,
} from '../src/agents/lp-range';
import type { AgentContext } from '../src/types';

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

/* ------------------------- emptied-position self-heal ---------------------- */

const EMPTY_BALANCES = { liquidity: BigInt(0), tokensOwed0: BigInt(0), tokensOwed1: BigInt(0) };

test('needsReentry flags a drained position and leaves a live one alone', () => {
  assert.equal(needsReentry(EMPTY_BALANCES), true);
  assert.equal(needsReentry({ ...EMPTY_BALANCES, liquidity: BigInt(1) }), false);
  assert.equal(
    needsReentry({ ...EMPTY_BALANCES, liquidity: BigInt('1234567890123456789') }),
    false,
  );
});

/*
 * decreaseLiquidity moves the principal into tokensOwed0/1 and leaves liquidity
 * at 0. If the collect that follows reverts or its receipt times out, the
 * position reads "no liquidity" while holding every token the agent owns.
 * Judging emptiness on liquidity alone therefore drops the tokenId from state,
 * and recoverPosition (which also needs something left in the NFT) can never
 * re-adopt it: the principal is orphaned with no attacker involved.
 */
test('needsReentry keeps a position that still owes tokens', () => {
  assert.equal(needsReentry({ ...EMPTY_BALANCES, tokensOwed0: BigInt(1) }), false);
  assert.equal(needsReentry({ ...EMPTY_BALANCES, tokensOwed1: BigInt(1) }), false);
  assert.equal(
    needsReentry({ liquidity: BigInt(0), tokensOwed0: BigInt('3342685000000000000'), tokensOwed1: BigInt(0) }),
    false,
  );
});

test('needsCollect separates "sweep me" from "empty" and from "live"', () => {
  assert.equal(needsCollect(EMPTY_BALANCES), false);
  assert.equal(needsCollect({ ...EMPTY_BALANCES, tokensOwed0: BigInt(1) }), true);
  assert.equal(needsCollect({ ...EMPTY_BALANCES, tokensOwed1: BigInt(1) }), true);
  /* Fees owed on a live position are collected by the normal exit, not swept. */
  assert.equal(needsCollect({ liquidity: BigInt(5), tokensOwed0: BigInt(1), tokensOwed1: BigInt(1) }), false);
});

/*
 * Live incident, 2026-08-22. The agent logged "Removed liquidity from position
 * #7209976 for rebalancing" and never re-minted, then range-checked that same
 * emptied tokenId every 10 minutes forever:
 *   {"event":"range-check","tokenId":"7209976","currentTick":-65620,
 *    "tickLower":-65720,"tickUpper":-64740,"inRange":true,"outSinceMs":null}
 * All three NPM tokens the wallet held reported liquidity 0, so the agent was
 * reporting a healthy in-range position while holding none and earning nothing.
 * recoverPosition already refuses zero-liquidity tokens, but it only ran when
 * state had NO position, so a stored-but-emptied tokenId was never revalidated.
 */

const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';
const WBNB = TOKENS_BSC['WBNB']!;
const USDT = TOKENS_BSC['USDT']!;
/* fee-500 WBNB/USDT pool and the tick from the stuck range-check log. */
const LIVE_POOL_INFO = {
  pool: '0x36696169C63e42cd08ce11f5deeBbCeBae652050',
  fee: 500,
  tickSpacing: 10,
  wbnbIsToken0: false,
};
const LIVE_TICK = -65620;
const LIVE_SQRT_PRICE_X96 = BigInt('3226319368666370249255859660');
const STUCK_POSITION = { tokenId: '7209976', tickLower: -65720, tickUpper: -64740, outSince: null };

/** A shallow fee-10000 book, the kind an adopted stranger position points at. */
const THIN_POOL = '0xdEaD00000000000000000000000000000000dEaD';

interface LpFakeOpts {
  position: typeof STUCK_POSITION | null;
  /** tokenId -> on-chain liquidity, the field the self-heal reads. */
  liquidityByTokenId: Record<string, bigint>;
  /** tokenId -> [tokensOwed0, tokensOwed1], where principal sits after a
   * decreaseLiquidity whose collect has not landed. */
  tokensOwedByTokenId?: Record<string, [bigint, bigint]>;
  /** tokenId -> fee tier, for positions that do not belong to the reference pool. */
  feeByTokenId?: Record<string, number>;
  /** NPM tokens the wallet owns, oldest first (recoverPosition walks newest first). */
  ownedTokenIds: string[];
  wbnbWei?: bigint;
  usdtWei?: bigint;
  /** Breaker verdict for every allowAction call (daily caps). */
  allowAction?: boolean;
  /** 60s TWAP tick the pool reports; defaults to spot, so the gate opens. */
  twapTick?: number;
  /** Write calls whose receipt comes back reverted, by function name. */
  revertedWrites?: string[];
  initialState?: Record<string, unknown>;
}

function fakeCtx(opts: LpFakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
  /** Sell tokens handed to executeOphisSwap: one entry per swap actually attempted. */
  swapAttempts: string[];
  writes: { functionName: string }[];
} {
  const store = new Map<string, unknown>([
    ['poolInfo', LIVE_POOL_INFO],
    ['position', opts.position],
    ...Object.entries(opts.initialState ?? {}),
  ]);
  const logs: Record<string, unknown>[] = [];
  const swapAttempts: string[] = [];
  const writes: { functionName: string }[] = [];
  const publicClient = {
    async waitForTransactionReceipt({ hash }: { hash: string }) {
      /* writeContract encodes the function name into the hash, so a test can
       * fail one specific call (a collect that reverts) and not the others. */
      const fn = hash.replace(/^0x/, '');
      const status = opts.revertedWrites?.includes(fn) ? 'reverted' : 'success';
      return { status, logs: [] };
    },
    async readContract(call: { address: string; functionName: string; args?: unknown[] }) {
      const { address, functionName, args } = call;
      /*
       * executeOphisSwap reads the sell token's decimals before it quotes, so a
       * decimals read is the point of no return into the real swap library. Record
       * it and stop there: the tests assert which swaps the agent decides to make,
       * not the orderbook round trip.
       */
      if (functionName === 'decimals') {
        swapAttempts.push(address.toLowerCase());
        return Promise.reject(new Error('test stub: swap stopped before the orderbook'));
      }
      /* Allowances are already in place, so ensureErc20Allowance sends no approve. */
      if (functionName === 'allowance') return BigInt(2) ** BigInt(200);
      if (functionName === 'observe') {
        /* Flat by default: the 60s TWAP tick equals spot, so the sandwich gate
         * opens. A twapTick opt skews it the way a sandwich would. */
        const twap = opts.twapTick ?? LIVE_TICK;
        return [[BigInt(0), BigInt(twap * 60)], [BigInt(0), BigInt(0)]];
      }
      if (functionName === 'positions') {
        const tokenId = String(args![0]);
        const liquidity = opts.liquidityByTokenId[tokenId] ?? BigInt(0);
        const [owed0, owed1] = opts.tokensOwedByTokenId?.[tokenId] ?? [BigInt(0), BigInt(0)];
        /* nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity,
         * feeGrowthInside0, feeGrowthInside1, tokensOwed0, tokensOwed1 */
        return [
          BigInt(0),
          '0x0000000000000000000000000000000000000000',
          USDT.address,
          WBNB.address,
          opts.feeByTokenId?.[tokenId] ?? LIVE_POOL_INFO.fee,
          STUCK_POSITION.tickLower,
          STUCK_POSITION.tickUpper,
          liquidity,
          BigInt(0),
          BigInt(0),
          owed0,
          owed1,
        ];
      }
      /* Only reached when a position sits in a pool other than the reference
       * one, i.e. when recoverPosition is about to repoint poolInfo. */
      if (functionName === 'getPool') return THIN_POOL;
      if (functionName === 'tickSpacing') return 200;
      if (functionName === 'balanceOf' && address.toLowerCase() === POSITION_MANAGER.toLowerCase())
        return BigInt(opts.ownedTokenIds.length);
      if (functionName === 'tokenOfOwnerByIndex')
        return BigInt(opts.ownedTokenIds[Number(args![1])]!);
      if (functionName === 'balanceOf' && address.toLowerCase() === WBNB.address.toLowerCase())
        return opts.wbnbWei ?? BigInt(0);
      if (functionName === 'balanceOf' && address.toLowerCase() === USDT.address.toLowerCase())
        return opts.usdtWei ?? BigInt(0);
      if (functionName === 'slot0')
        return [LIVE_SQRT_PRICE_X96, LIVE_TICK, 0, 0, 0, 0, true];
      throw new Error(`unexpected read ${functionName}@${address}`);
    },
  };
  const walletClient = {
    chain: { id: 56 },
    async writeContract(call: { functionName: string }) {
      writes.push(call);
      return `0x${call.functionName}`;
    },
  };
  const ctx = {
    name: 'lp-range',
    chainId: 56,
    account: { address: '0x79827EF1faDeA3B30A8E77fdbaF17944298A3bB6' },
    publicClient,
    walletClient,
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
      halt() {},
      isHalted: () => ({ halted: false }),
      allowAction: () => opts.allowAction ?? true,
    },
  } as unknown as AgentContext;
  return { ctx, logs, store, swapAttempts, writes };
}

test('a stored position drained to zero liquidity is treated as absent, not range-checked', async () => {
  const { ctx, logs, store } = fakeCtx({
    position: { ...STUCK_POSITION },
    /* All three wallet NFTs empty, exactly as the chain reported. */
    liquidityByTokenId: {},
    ownedTokenIds: ['7173629', '7191882', '7209976'],
    usdtWei: BigInt('3340000000000000000'), // the ~3.34 USDT left idle
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  const empty = logs.find((l) => l.event === 'position-empty');
  assert.ok(empty, `expected a position-empty event, got ${JSON.stringify(events)}`);
  assert.equal(empty!['tokenId'], '7209976');
  assert.equal(store.get('position'), null, 'the emptied tokenId must be cleared from state');
  assert.ok(
    !events.includes('range-check'),
    'an emptied position must never be reported as in range',
  );
  /* Same tick continues into the recover-then-mint path instead of idling. */
  assert.ok(events.includes('mint-skipped'), `expected the mint path to run, got ${JSON.stringify(events)}`);
});

test('a stored position with live liquidity is still range-checked, never cleared', async () => {
  const { ctx, logs, store } = fakeCtx({
    position: { ...STUCK_POSITION },
    liquidityByTokenId: { '7209976': BigInt('1000000000000000') },
    ownedTokenIds: ['7209976'],
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  assert.ok(!events.includes('position-empty'), 'a funded position must not be cleared');
  const check = logs.find((l) => l.event === 'range-check');
  assert.ok(check, `expected a range-check event, got ${JSON.stringify(events)}`);
  assert.equal(check!['tokenId'], '7209976');
  assert.equal(check!['inRange'], true);
  assert.deepEqual(store.get('position'), STUCK_POSITION);
});

/* --------------------- one-sided wallet, no position ----------------------- */

/*
 * Same incident, one layer down. Clearing the emptied tokenId let the agent tell
 * the truth but not act on it: with no position the tick called tryMint and
 * returned, and rebalanceInventory was reachable ONLY from the rebalance branch,
 * which needs a position to reach. The wallet left behind by the interrupted
 * rebalance held 3.342685 USDT and 0.000206485 WBNB; after the 0.0002 WBNB gas
 * reserve the WBNB leg is worth about $0.0039 against a $0.05 mint floor, so the
 * agent logged mint-skipped/insufficient-leg every 10 minutes and never traded
 * its way back into a mintable inventory.
 */

const LIVE_USDT_WEI = BigInt('3342685000000000000'); // 3.342685 USDT
const LIVE_WBNB_WEI = BigInt('206485000000000'); // 0.000206485 WBNB
/** Spot price the fake slot0 implies: 603.04 USDT per WBNB. */
const LIVE_PRICE = 603.0376903689724;

test('needsInventoryPrep flags a wallet that cannot fund both mint legs', () => {
  /* The live incident: plenty of USDT, a WBNB leg worth $0.0039. */
  assert.equal(needsInventoryPrep(0.000006485, 3.242685, LIVE_PRICE), true);
  /* Mirror image: WBNB rich, no USDT. */
  assert.equal(needsInventoryPrep(0.005, 0, LIVE_PRICE), true);
  /* Both legs above the floor: nothing to prepare. */
  assert.equal(needsInventoryPrep(0.0033, 1.99, LIVE_PRICE), false);
  /* Exactly at the floor on both sides still mints (strict less-than). */
  assert.equal(needsInventoryPrep(MIN_MINT_LEG_USD / LIVE_PRICE, MIN_MINT_LEG_USD, LIVE_PRICE), false);
});

test('no position and a one-sided wallet prepares inventory instead of idling', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: [],
    usdtWei: LIVE_USDT_WEI,
    wbnbWei: LIVE_WBNB_WEI,
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  const prep = logs.find((l) => l.event === 'inventory-prep');
  assert.ok(prep, `expected an inventory-prep event, got ${JSON.stringify(events)}`);
  /* Half the value gap, sold from the heavy side: ~$1.61 of USDT into WBNB. */
  assert.equal(prep!['sell'], 'USDT');
  const notional = prep!['notionalUsd'] as number;
  assert.ok(Math.abs(notional - 1.609) < 0.01, `unexpected prep notional ${notional}`);
  assert.deepEqual(
    swapAttempts,
    [USDT.address.toLowerCase()],
    'the prep must actually reach the swap, selling USDT',
  );
});

test('no position and a balanced wallet mints straight away, with no swap', async () => {
  const { ctx, logs, store, swapAttempts, writes } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    /* An NPM token with no liquidity: nothing to recover, and the id the mint
     * receipt fallback reports once the new position is opened. */
    ownedTokenIds: ['7300001'],
    usdtWei: BigInt('2100000000000000000'), // 2.1 USDT
    wbnbWei: BigInt('3500000000000000'), // 0.0035 WBNB, ~$2.11
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  assert.ok(
    !events.some((e) => String(e).startsWith('inventory-prep')),
    `a balanced wallet needs no prep, got ${JSON.stringify(events)}`,
  );
  assert.deepEqual(swapAttempts, [], 'a balanced wallet must not trade before minting');
  const minted = logs.find((l) => l.event === 'minted');
  assert.ok(minted, `expected a mint, got ${JSON.stringify(events)}`);
  assert.equal(minted!['tokenId'], '7300001');
  /* snapRange(-65620, 487, 10) around the live tick. */
  assert.equal(minted!['tickLower'], -66110);
  assert.equal(minted!['tickUpper'], -65130);
  assert.deepEqual(writes.map((w) => w.functionName), ['mint']);
  assert.equal((store.get('position') as { tokenId: string }).tokenId, '7300001');
});

test('inventory prep is refused when the daily breaker says no', async () => {
  const { ctx, logs, swapAttempts, writes } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: [],
    usdtWei: LIVE_USDT_WEI,
    wbnbWei: LIVE_WBNB_WEI,
    allowAction: false,
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  assert.ok(!events.includes('inventory-prep'), 'a blocked breaker must not swap');
  const skipped = logs.find((l) => l.event === 'inventory-prep-skipped');
  assert.ok(skipped, `expected inventory-prep-skipped, got ${JSON.stringify(events)}`);
  assert.equal(skipped!['reason'], 'daily-cap');
  assert.deepEqual(swapAttempts, []);
  assert.deepEqual(writes, []);
  /* Still honest about why it did not mint. */
  assert.ok(events.includes('mint-skipped'));
});

test('inventory prep is refused when the weekly rebalance budget is spent', async () => {
  const now = Date.now();
  const { ctx, logs, swapAttempts } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: [],
    usdtWei: LIVE_USDT_WEI,
    wbnbWei: LIVE_WBNB_WEI,
    initialState: {
      rebalanceTimes: Array.from({ length: MAX_REBALANCES_PER_WEEK }, (_, i) => now - i * 3600_000),
    },
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  const skipped = logs.find((l) => l.event === 'inventory-prep-skipped');
  assert.ok(skipped, `expected inventory-prep-skipped, got ${JSON.stringify(events)}`);
  assert.equal(skipped!['reason'], 'weekly-cap');
  assert.deepEqual(swapAttempts, []);
});

/* ------------------- uncollected principal must not be dropped ------------- */

/*
 * The exit is two transactions: decreaseLiquidity, then collect. Between them
 * the principal sits in tokensOwed0/1 with liquidity at 0. A collect that
 * reverts (or whose receipt times out) leaves the position exactly there, so a
 * self-heal that reads liquidity only would clear the stored tokenId, and the
 * NFT holding the money would never be looked at again.
 */

const OWED_USDT = BigInt('3342685000000000000');
const OWED_WBNB = BigInt('5500000000000000');

test('a position with zero liquidity but tokens still owed is collected before it is let go', async () => {
  const { ctx, logs, store, writes } = fakeCtx({
    position: { ...STUCK_POSITION },
    liquidityByTokenId: {},
    tokensOwedByTokenId: { '7209976': [OWED_USDT, OWED_WBNB] },
    ownedTokenIds: ['7209976'],
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  assert.ok(
    !events.includes('position-empty'),
    `a position still owing tokens is not empty, got ${JSON.stringify(events)}`,
  );
  const uncollected = logs.find((l) => l.event === 'position-uncollected');
  assert.ok(uncollected, `expected position-uncollected, got ${JSON.stringify(events)}`);
  assert.equal(uncollected!['tokensOwed0'], OWED_USDT.toString());
  assert.deepEqual(
    writes.map((w) => w.functionName),
    ['collect'],
    'the owed principal must be collected, and with no liquidity left there is nothing to decrease',
  );
  assert.ok(events.includes('position-swept'));
  /* Only once the collect landed may the tokenId be released. */
  assert.equal(store.get('position'), null);
});

test('an uncollected position stays stored when the collect fails, so it can be retried', async () => {
  const { ctx, logs, store, writes } = fakeCtx({
    position: { ...STUCK_POSITION },
    liquidityByTokenId: {},
    tokensOwedByTokenId: { '7209976': [OWED_USDT, OWED_WBNB] },
    ownedTokenIds: ['7209976'],
    revertedWrites: ['collect'],
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  assert.ok(events.includes('collect-reverted'));
  assert.ok(events.includes('position-sweep-deferred'));
  assert.ok(!events.includes('position-empty'), 'a failed collect must not orphan the principal');
  assert.deepEqual(
    store.get('position'),
    STUCK_POSITION,
    'the tokenId must survive in state, otherwise nothing can ever reach the owed tokens again',
  );
  /* And it must not be range-checked either: it holds no liquidity. */
  assert.ok(!events.includes('range-check'));
  assert.deepEqual(writes.map((w) => w.functionName), ['collect']);
});

/* --------------------- one weekly budget for both paths -------------------- */

test('weeklyBudget counts both windows against the published ceiling', () => {
  const now = 10 * WEEK_MS;
  const budget = weeklyBudget([now - DAY_MS, now - 2 * DAY_MS], [now - 3 * DAY_MS], now);
  assert.equal(budget.rebalances.length, 2);
  assert.equal(budget.preps.length, 1);
  assert.equal(budget.used, 3);
  assert.equal(budget.exhausted, false);
  const full = weeklyBudget([now - DAY_MS, now - 2 * DAY_MS], [now - 3 * DAY_MS, now - 4 * DAY_MS], now);
  assert.equal(full.used, MAX_REBALANCES_PER_WEEK);
  assert.equal(full.exhausted, true);
  /* Entries outside the week do not count, in either window. */
  const stale = weeklyBudget([now - 2 * WEEK_MS], [now - 2 * WEEK_MS], now);
  assert.equal(stale.used, 0);
});

/*
 * prepareInventory checked rebalanceTimes and refused at the ceiling, but only
 * wrote the pruned array back inside the refusal branch: passing the check
 * recorded nothing. Its real ceiling was the daily breaker alone, 2 a day and
 * so 14 a week, against the maxRebalancesPerWeek: 4 published at the agent's
 * permanent ERC-8004 tokenURI.
 */
test('inventory prep spends the weekly budget it checks, so the published cap binds', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: [],
    usdtWei: LIVE_USDT_WEI,
    wbnbWei: LIVE_WBNB_WEI,
  });

  for (let i = 0; i < MAX_REBALANCES_PER_WEEK + 1; i += 1) {
    await lpRangeAgent.tick(ctx);
  }

  assert.equal(
    swapAttempts.length,
    MAX_REBALANCES_PER_WEEK,
    `the prep path must stop at the weekly ceiling, it swapped ${swapAttempts.length} times`,
  );
  const capped = logs.filter((l) => l.event === 'inventory-prep-skipped' && l['reason'] === 'weekly-cap');
  assert.equal(capped.length, 1, 'the tick past the ceiling must be refused, not swapped');
  assert.equal(capped[0]!['inventoryPrepsThisWeek'], MAX_REBALANCES_PER_WEEK);
  /* Position rebalances stay reported apart from prep swaps. */
  assert.equal(capped[0]!['rebalancesThisWeek'], 0);
  const status = await lpRangeAgent.status(ctx);
  assert.equal(status['rebalancesThisWeek'], 0);
  assert.equal(status['inventoryPrepsThisWeek'], MAX_REBALANCES_PER_WEEK);
  assert.equal(status['weeklyBudgetUsed'], MAX_REBALANCES_PER_WEEK);
});

/* ------------------------- prep swap under the TWAP gate ------------------- */

/*
 * tryMint and exitPosition both refuse to act while spot has been pushed away
 * from the 60s TWAP. The prep swap sits between them, is sized from the same
 * unguarded spot price, and had no gate at all.
 */
test('inventory prep stands down while spot price is skewed from the TWAP', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: [],
    usdtWei: LIVE_USDT_WEI,
    wbnbWei: LIVE_WBNB_WEI,
    twapTick: LIVE_TICK + 500, // 5x the 100-tick tolerance
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  const skipped = logs.find((l) => l.event === 'inventory-prep-skipped');
  assert.ok(skipped, `expected inventory-prep-skipped, got ${JSON.stringify(events)}`);
  assert.equal(skipped!['reason'], 'twap-deviation');
  assert.deepEqual(swapAttempts, [], 'a skewed book must not size a swap');
  /* The budget is untouched: a deferred action costs nothing. */
  assert.equal((await lpRangeAgent.status(ctx))['weeklyBudgetUsed'], 0);
});

/* ---------------- adoption is restricted to the agent's own mints ---------- */

test('rememberTokenId keeps the newest ids, without duplicates', () => {
  assert.deepEqual(rememberTokenId([], '1'), ['1']);
  assert.deepEqual(rememberTokenId(['1', '2'], '3'), ['1', '2', '3']);
  assert.deepEqual(rememberTokenId(['1', '2'], '1'), ['2', '1']);
  const many = Array.from({ length: MINTED_HISTORY_LIMIT + 5 }, (_, i) => String(i));
  const capped = rememberTokenId(many, 'x');
  assert.equal(capped.length, MINTED_HISTORY_LIMIT);
  assert.equal(capped.at(-1), 'x');
});

/*
 * Anyone can transfer a PancakeSwap V3 position NFT to the agent's EOA.
 * recoverPosition adopted any WBNB/USDT position the wallet held with live
 * liquidity, and when the fee tier differed it PERSISTED a repointed poolInfo,
 * which resolvePool then returns for every later tick: range-checks, exits and
 * new mints all move to the donated position's pool. The fee-10000 WBNB/USDT
 * book holds around $14 of depth, so the donation costs an attacker almost
 * nothing and buys a reference price that is cheap to skew.
 */
test('a donated position is never adopted and never repoints the reference pool', async () => {
  const { ctx, logs, store } = fakeCtx({
    position: null,
    liquidityByTokenId: { '9999001': BigInt('1000000000000000') },
    feeByTokenId: { '9999001': 10000 },
    /* The donated NFT, plus an old drained one of the agent's own. */
    ownedTokenIds: ['9999001', '7300001'],
    usdtWei: BigInt('2100000000000000000'),
    wbnbWei: BigInt('3500000000000000'),
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  assert.ok(
    !events.includes('position-recovered'),
    `a position the agent never minted must not be adopted, got ${JSON.stringify(events)}`,
  );
  const ignored = logs.find((l) => l.event === 'position-ignored');
  assert.ok(ignored, `expected position-ignored, got ${JSON.stringify(events)}`);
  assert.equal(ignored!['reason'], 'not-minted-by-agent');
  assert.deepEqual(
    store.get('poolInfo'),
    LIVE_POOL_INFO,
    'the reference pool must stay the deepest pool the agent selected',
  );
  /* It mints its own position instead of managing a stranger's. */
  assert.ok(events.includes('minted'));
  assert.equal((store.get('position') as { tokenId: string }).tokenId, '7300001');
});

/*
 * Migration guard. #7248592 was minted on 2026-08-24, before the agent started
 * recording its own mints, and it is the live position: it must keep being
 * managed under the minted-id restriction.
 */
test('the live position 7248592 is still adopted when state has no position', async () => {
  const { ctx, logs, store } = fakeCtx({
    position: null,
    liquidityByTokenId: { '7248592': BigInt('2451189888573570005') },
    ownedTokenIds: ['7248592'],
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  const recovered = logs.find((l) => l.event === 'position-recovered');
  assert.ok(recovered, `expected position-recovered, got ${JSON.stringify(events)}`);
  assert.equal(recovered!['tokenId'], '7248592');
  assert.equal((store.get('position') as { tokenId: string }).tokenId, '7248592');
  const check = logs.find((l) => l.event === 'range-check');
  assert.ok(check, 'the recovered live position must be range-checked as usual');
  assert.equal(check!['tokenId'], '7248592');
});

test('a position the agent mints is remembered, so it can be adopted after a state loss', async () => {
  const { ctx, store } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: ['7300001'],
    usdtWei: BigInt('2100000000000000000'),
    wbnbWei: BigInt('3500000000000000'),
  });

  await lpRangeAgent.tick(ctx);

  assert.deepEqual(store.get('mintedTokenIds'), ['7300001']);
});

test('inventory prep leaves a dust wallet alone rather than swapping under the min notional', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    position: null,
    liquidityByTokenId: {},
    ownedTokenIds: [],
    usdtWei: BigInt('300000000000000000'), // 0.3 USDT, gap under MIN_SWAP_NOTIONAL_USD
    wbnbWei: BigInt('0'),
  });

  await lpRangeAgent.tick(ctx);

  const events = logs.map((l) => l.event);
  const skipped = logs.find((l) => l.event === 'inventory-prep-skipped');
  assert.ok(skipped, `expected inventory-prep-skipped, got ${JSON.stringify(events)}`);
  assert.equal(skipped!['reason'], 'imbalance-under-min-notional');
  assert.deepEqual(swapAttempts, []);
  assert.ok(events.includes('mint-skipped'));
});
