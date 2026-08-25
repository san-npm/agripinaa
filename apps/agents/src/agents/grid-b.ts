/**
 * Grid B: BTCB/USDT mean-reversion grid on BSC, the second agent in the grid
 * category and a deliberate contrast with `grid` rather than a copy of it.
 *
 * Same strategy, same venue (every swap is an Ophis batch auction), same halts,
 * different parameterisation on a different market: five levels each side at 2.5
 * percent spacing (grid runs four at 1.5), $1.50 clips (grid $2), 8 trades a day
 * (grid 12), and a 45 minute cooldown (grid 31). Wider and slower, so the two
 * track records answer an open question: does a patient ladder on BTC beat a
 * tight one on BNB?
 *
 * The pair matters as much as the parameters. This agent first ran WBNB/USDC,
 * which is the same underlying market as grid's WBNB/USDT priced in a second
 * dollar: both agents would have seen identical BNB price action and produced
 * correlated track records, so the grid hub would have listed one strategy
 * twice. BTCB is a different asset with its own volatility, and its book is far
 * deeper: measured on-chain 2026-08-25, the BTCB/USDT fee-500 pool held about
 * 9.46 million USDT against the 1.47 million of the deepest WBNB/USDC pool.
 * BTC also realises less volatility than BNB, so a 2.5 percent ladder here
 * crosses less often than the same ladder would have on WBNB. That is the
 * patient end of the comparison, not a defect.
 *
 * USDT stays the quote because inventoryValueUsd sums base * price + quote and
 * calls the result dollars, and both the drawdown halt and the clip sizing rest
 * on that. A non-dollar quote (BTCB/WBNB, say) would quietly make every one of
 * those numbers mean something else.
 *
 * All of the strategy arithmetic is the shared core in ../grid-core, which
 * `grid` uses too. This file owns only THIS grid's parameters, its pair, and
 * its tick wiring, and every core call passes GRID_B_PARAMS explicitly so the
 * two agents cannot inherit each other's numbers.
 *
 * The BTCB/USDT pool is resolved through the PancakeSwap V3 factory at runtime
 * and validated (pair, fee tier, deepest of the eligible tiers) exactly as
 * `grid` resolves WBNB/USDT: nothing about the book is hardcoded here.
 */
import { executeOphisSwap } from '@ophis/agent-swap';
import { TOKENS_BSC, toBaseUnits, fromBaseUnits } from '@agripinaa/shared';

import {
  buildLadder,
  clipForLevel,
  computeLevels,
  detectCrossing,
  evaluateGuards,
  effectiveClipUsd,
  inventoryValueUsd,
  isGridStale,
  isLossBreach,
  isSuppressedByMark,
  isTrendBreakout,
  lossFloorOf,
  maybeRecenter,
  readBalances,
  readMidPrice,
  resolveReferencePool,
  spacingOf,
  trendBandOf,
  unmarkNearCenter,
  type FillRecord,
  type GridPair,
  type GridParams,
} from '../grid-core';
import { ChassisOphisWallet } from '../ophis-wallet';
import type { AgentContext, AgentModule } from '../types';

export { buildLadder };

const BTCB = TOKENS_BSC.BTCB!;
const USDT = TOKENS_BSC.USDT!;

/** Base first: the price this agent works in is USDT per BTCB. */
const PAIR: GridPair = { base: BTCB, quote: USDT };
const CLIP_SYMBOLS = { base: 'BTCB', quote: 'USDT' } as const;

/**
 * Every number this agent enforces, in the units its manifest publishes them
 * in. The manifest's `safety` block is built from these fields, so what an
 * x402 client reads and what the tick applies are the same values.
 */
export const GRID_B_PARAMS: GridParams = {
  pair: 'BTCB/USDT',
  spacingPct: 2.5,
  levelsPerSide: 5,
  clipUsd: 1.5,
  /* Same floor as grid and lp-range: below a dollar a swap is not worth its
   * own fee on this venue. On BTCB a $1 clip is about 0.0000127 of a coin, and
   * clipForLevel quotes it to 6 significant figures, so the order still carries
   * ten decimal places of resolution against the token's eighteen. */
  minClipUsd: 1,
  /* Must exceed the Ophis order validity (~30 min), or a new clip can be
   * submitted while a previous order is still executable and the two fill
   * against unreserved balance. 45 minutes also spaces this ladder's 8 daily
   * trades out across the day rather than clustering them. */
  cooldownMs: 45 * 60_000,
  maxTradesPerDay: 8,
  maxRecentersPerDay: 3,
  trendHaltBandPct: 6,
  lossHaltPct: 5,
  staleRecenterMs: 12 * 60 * 60_000,
};

const SPACING = spacingOf(GRID_B_PARAMS);
const TREND_MAX_DEVIATION = trendBandOf(GRID_B_PARAMS);
const LOSS_FLOOR_FRACTION = lossFloorOf(GRID_B_PARAMS);

/**
 * Ticked every 3 minutes. The nearest rung sits 2.5 percent away and the
 * cooldown is 45 minutes, so nothing is missed by looking less often than
 * `grid` does, and the pool reads cost less.
 */
const TICK_INTERVAL_MS = 180_000;
const SLIPPAGE_BPS = 100;
const FILL_HISTORY = 20;

export const gridBAgent: AgentModule = {
  name: 'grid-b',
  category: 'grid',
  tickIntervalMs: TICK_INTERVAL_MS,

  async tick(ctx) {
    if (ctx.breakers.isHalted().halted) return;

    const pool = await resolveReferencePool(ctx, PAIR);
    const price = await readMidPrice(ctx, pool);
    const balances = await readBalances(ctx, PAIR);
    const btcbWhole = Number(fromBaseUnits(balances.base, BTCB.decimals));
    const usdtWhole = Number(fromBaseUnits(balances.quote, USDT.decimals));
    const inventoryNowUsd = inventoryValueUsd(btcbWhole, usdtWhole, price);

    // Fail SAFE on a corrupt read: a non-finite or non-positive price or
    // inventory would make the breakout and loss comparisons quietly false, or
    // poison the stored center. Skip the tick rather than trade on it.
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(inventoryNowUsd) ||
      inventoryNowUsd <= 0
    ) {
      ctx.log({ event: 'bad-read', price, inventoryNowUsd });
      return;
    }

    const storedCenter = ctx.state.get<number | null>('center', null);
    if (storedCenter === null) {
      // Baseline BEFORE center. Each set is atomic, so a crash mid-init can
      // leave a baseline with no center (which re-inits cleanly) but never a
      // center with no baseline.
      ctx.state.set('inventoryStartUsd', inventoryNowUsd);
      ctx.state.set('lastPrice', price);
      ctx.state.set('center', price);
      ctx.log({
        event: 'grid-init',
        center: price,
        inventoryStartUsd: inventoryNowUsd,
        btcbWhole,
        usdtWhole,
        pool: pool.address,
        feeTier: pool.fee,
      });
      return;
    }
    const center = storedCenter;
    // Fail CLOSED: a center with no valid baseline means the drawdown floor is
    // disabled, so halt instead of trading without it.
    const inventoryStartUsd = ctx.state.get<number | null>('inventoryStartUsd', null);
    if (
      inventoryStartUsd === null ||
      !Number.isFinite(inventoryStartUsd) ||
      inventoryStartUsd <= 0
    ) {
      ctx.log({ event: 'state-incomplete', reason: 'center set without a valid loss baseline' });
      ctx.breakers.halt('state-incomplete');
      return;
    }
    const prevPrice = ctx.state.get<number>('lastPrice', price);
    ctx.state.set('lastPrice', price);

    // Capital protection before adaptation: the drawdown halt is checked first
    // so it wins on a move that is both a loss breach and a breakout. The
    // baseline is set once at init and is never re-baselined, so the 5 percent
    // floor is cumulative over the agent's whole life, and the halt it trips is
    // permanent until an operator clears the state file. Both facts are
    // published in the manifest rather than left as a surprise.
    if (isLossBreach(inventoryNowUsd, inventoryStartUsd, LOSS_FLOOR_FRACTION)) {
      ctx.log({ event: 'daily-loss', inventoryNowUsd, inventoryStartUsd });
      ctx.breakers.halt('daily-loss');
      return;
    }
    if (isTrendBreakout(price, center, TREND_MAX_DEVIATION)) {
      // Two consecutive ticks before re-arming, so a single-tick spike or a
      // whipsaw does not re-center the ladder into noise.
      const streak = ctx.state.get<number>('breakoutStreak', 0) + 1;
      ctx.state.set('breakoutStreak', streak);
      if (streak < 2) {
        ctx.log({ event: 'breakout-observed', price, center, streak });
        return;
      }
      ctx.state.set('breakoutStreak', 0);
      if (maybeRecenter(ctx, price, inventoryNowUsd, GRID_B_PARAMS.maxRecentersPerDay)) return;
      ctx.log({ event: 'trend-breakout', price, center });
      ctx.breakers.halt('trend-breakout');
      return;
    }
    if (ctx.state.get<number>('breakoutStreak', 0) !== 0) ctx.state.set('breakoutStreak', 0);

    let crossed = ctx.state.get<string[]>('crossedLevels', []);
    const afterUnmark = unmarkNearCenter(price, center, crossed, SPACING);
    if (afterUnmark.length !== crossed.length) {
      ctx.log({ event: 'levels-unmarked', cleared: crossed, price, center });
      ctx.state.set('crossedLevels', afterUnmark);
      crossed = afterUnmark;
    }

    const levels = computeLevels(center, SPACING, GRID_B_PARAMS.levelsPerSide);
    const hit = detectCrossing(prevPrice, price, levels, crossed);
    if (!hit) {
      // A long drought while a mark sits on a level the price already satisfies
      // means the center has drifted out of the market's reach: the grid is not
      // quiet, it is dead, because marks only clear inside the un-mark band.
      // Re-arm through the SAME capped path a breakout uses. Both conditions
      // are required: the drought says it cannot recover on its own, the mark
      // says there is something to recover. Checked only here, so a re-center
      // can never pre-empt a clip that was about to trade.
      const nowMs = Date.now();
      const lastFillAtMs = ctx.state.get<number | null>('lastFillAt', null);
      if (
        lastFillAtMs !== null &&
        isGridStale(
          nowMs,
          lastFillAtMs,
          price,
          center,
          GRID_B_PARAMS.staleRecenterMs,
          SPACING,
        ) &&
        isSuppressedByMark(price, levels, crossed)
      ) {
        const hoursSinceLastFill = (nowMs - lastFillAtMs) / 3_600_000;
        if (
          maybeRecenter(ctx, price, inventoryNowUsd, GRID_B_PARAMS.maxRecentersPerDay, 'stale', {
            hoursSinceLastFill,
          })
        ) {
          return;
        }
        // Budget spent: fall through to the ordinary tick log. A grid with no
        // fills is idle, not a runaway trend, and the breakout path owns the
        // halt.
      }
      ctx.log({ event: 'tick', price, center, inventoryNowUsd, crossedCount: crossed.length });
      return;
    }

    // Size the clip to what the spending leg can fund: a buy spends USDT, a
    // sell spends BTCB. This only ever shrinks the clip, never grows it.
    const affordableUsd = hit.level.side === 'buy' ? usdtWhole : btcbWhole * price;
    const clipUsd = effectiveClipUsd(
      GRID_B_PARAMS.clipUsd,
      affordableUsd,
      GRID_B_PARAMS.minClipUsd,
    );
    const reducedClip = clipUsd > 0 && clipUsd < GRID_B_PARAMS.clipUsd;
    // 0 means the leg cannot fund even the floor. Quote the DESIRED size so the
    // balance guard below blocks it with insufficient-balance exactly as an
    // empty wallet does; quoting 0 would throw in toSignificant instead.
    const clip = clipForLevel(
      hit.level.side,
      price,
      clipUsd > 0 ? clipUsd : GRID_B_PARAMS.clipUsd,
      CLIP_SYMBOLS,
    );
    const clipAdaptation = reducedClip
      ? { desiredClipUsd: GRID_B_PARAMS.clipUsd, effectiveClipUsd: clipUsd }
      : {};
    const clipToken = clip.token === 'BTCB' ? BTCB : USDT;
    const clipBaseUnits = toBaseUnits(clip.amount, clipToken.decimals);
    const balanceBaseUnits = clip.token === 'BTCB' ? balances.base : balances.quote;

    const guard = evaluateGuards({
      nowMs: Date.now(),
      lastFillAtMs: ctx.state.get<number | null>('lastFillAt', null),
      price,
      center,
      inventoryNowUsd,
      inventoryStartUsd,
      clipBaseUnits,
      balanceBaseUnits,
      allowTrade: () => ctx.breakers.allowAction('trade', GRID_B_PARAMS.maxTradesPerDay),
      cooldownMs: GRID_B_PARAMS.cooldownMs,
      maxDeviation: TREND_MAX_DEVIATION,
      lossFloor: LOSS_FLOOR_FRACTION,
    });
    if (!guard.ok) {
      ctx.log({
        event: 'trade-blocked',
        reason: guard.reason,
        level: hit.level.key,
        price,
        center,
        inventoryNowUsd,
        ...clipAdaptation,
      });
      if (guard.halt) ctx.breakers.halt(guard.reason);
      return;
    }

    const sellToken = hit.level.side === 'sell' ? BTCB.address : USDT.address;
    const buyToken = hit.level.side === 'sell' ? USDT.address : BTCB.address;
    ctx.log({
      event: 'trade-intent',
      side: hit.level.side,
      level: hit.level.key,
      crossedThisTick: hit.crossedThisTick,
      sellToken,
      buyToken,
      sellAmount: clip.amount,
      price,
      center,
      ...clipAdaptation,
    });

    // Persist the cooldown anchor and the level mark BEFORE submitting: a crash
    // in the submit window must not lose them, or a restart would re-fire the
    // same clip with no cooldown. The worst case on a failed submit is one
    // skipped clip, which is the safe direction.
    ctx.state.set('lastFillAt', Date.now());
    ctx.state.set('crossedLevels', [...crossed, hit.level.key]);

    const wallet = new ChassisOphisWallet(ctx.account, ctx.publicClient, ctx.walletClient);
    const result = await executeOphisSwap(
      wallet,
      { sellToken, buyToken, sellAmount: clip.amount, slippageBps: SLIPPAGE_BPS },
      {},
    );
    ctx.log({
      event: 'trade-submitted',
      orderUid: result.orderUid,
      side: hit.level.side,
      level: hit.level.key,
      clipToken: clip.token,
      clipAmount: clip.amount,
      price,
      center,
      minBuyAmount: result.minBuyAmount,
      explorerUrl: result.explorerUrl,
      enrollmentWarning: result.enrollmentWarning ?? null,
      ...clipAdaptation,
    });

    const fill: FillRecord = {
      at: new Date().toISOString(),
      side: hit.level.side,
      level: hit.level.key,
      clipToken: clip.token,
      clipAmount: clip.amount,
      price,
      orderUid: result.orderUid,
    };
    const fills = [...ctx.state.get<FillRecord[]>('fills', []), fill].slice(-FILL_HISTORY);
    ctx.state.set('fills', fills);
  },

  async status(ctx) {
    const halted = ctx.breakers.isHalted();
    const center = ctx.state.get<number | null>('center', null);
    const crossed = new Set(ctx.state.get<string[]>('crossedLevels', []));
    const fills = ctx.state.get<FillRecord[]>('fills', []);
    const inventoryStartUsd = ctx.state.get<number | null>('inventoryStartUsd', null);

    let price: number | null = null;
    let inventoryNowUsd: number | null = null;
    let error: string | undefined;
    try {
      const pool = await resolveReferencePool(ctx, PAIR);
      price = await readMidPrice(ctx, pool);
      const balances = await readBalances(ctx, PAIR);
      inventoryNowUsd = inventoryValueUsd(
        Number(fromBaseUnits(balances.base, BTCB.decimals)),
        Number(fromBaseUnits(balances.quote, USDT.decimals)),
        price,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      pair: GRID_B_PARAMS.pair,
      params: GRID_B_PARAMS,
      center,
      price,
      levels:
        center === null
          ? []
          : computeLevels(center, SPACING, GRID_B_PARAMS.levelsPerSide).map((l) => ({
              price: l.price,
              side: l.side,
              crossed: crossed.has(l.key),
            })),
      fills: fills.slice(-10),
      inventoryStartUsd,
      inventoryNowUsd,
      halted,
      ...(error ? { error } : {}),
    };
  },
};
