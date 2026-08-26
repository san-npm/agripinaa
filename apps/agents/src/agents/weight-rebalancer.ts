/**
 * Weight Rebalancer: holds WBNB and USDT at a 50/50 split by value and puts the
 * split back with ONE Ophis swap whenever drift leaves a 5 percent band.
 *
 * The second agent in the rebalancing category, and a different idea from the
 * LP Ranger rather than a variation on it. The Ranger rebalances because a
 * concentrated-liquidity position drifted out of its range; this one has no
 * position at all, and rebalances because the market moved the weights. Same
 * category on the marketplace, opposite reason to act, and each rebalance mints
 * another Ophis settlement receipt for the proof feed.
 *
 * The drift arithmetic is ../value-split, which is where the Ranger reads its
 * own 50/50 leg from, so the two agents measure imbalance with one function.
 * The pool resolution, price read and balance read are ../grid-core, the same
 * factory-validated path the grid agents use. What is local to this file is the
 * band, the caps, and the wiring.
 *
 * Deliberately NOT here: a drawdown halt. This agent takes no directional view,
 * so there is no position to protect with one; its exposure is the churn of
 * rebalancing, which the daily cap, the cooldown and the minimum notional
 * bound. The manifest says so rather than implying a halt that does not exist.
 */
import { executeOphisSwap } from '@ophis/agent-swap';
import { TOKENS_BSC, toBaseUnits, fromBaseUnits } from '@agripinaa/shared';

import {
  effectiveClipUsd,
  inventoryValueUsd,
  isCooldownActive,
  readBalances,
  readMidPrice,
  resolveReferencePool,
  toSignificant,
  type GridPair,
} from '../grid-core';
import { ChassisOphisWallet } from '../ophis-wallet';
import { independentMinimumBuyAmount } from '../quote-guard';
import type { AgentModule } from '../types';
import { driftPoints, valueGapUsd, weightOfBase } from '../value-split';

const WBNB = TOKENS_BSC.WBNB!;
const USDT = TOKENS_BSC.USDT!;

/** Base first: the price this agent works in is USDT per WBNB. */
const PAIR: GridPair = { base: WBNB, quote: USDT };

/** Target share of total value held in the base token. */
export const TARGET_WEIGHT = 0.5;
/** Drift tolerated before a rebalance, in percentage points of weight. */
export const BAND_PCT = 5;
/** Below this the swap is not worth its own fee; same floor the LP agent and
 * the grids apply on this pair and this venue. */
export const MIN_TRADE_USD = 1;
export const MAX_REBALANCES_PER_DAY = 4;
/**
 * Must outlast an Ophis order (about 30 minutes of validity). The tick is 10
 * minutes, so without this a rebalance could be signed three more times while
 * the first order was still executable, each sized from a book that already
 * assumed the earlier one had filled, and the same side would be sold several
 * times over.
 */
export const COOLDOWN_MS = 35 * 60_000;
const TICK_INTERVAL_MS = 600_000;
const SLIPPAGE_BPS = 100;
const HISTORY_LIMIT = 20;

export type WeightSide = 'buy' | 'sell' | 'none';

export interface WeightTrade {
  /** From the base token's point of view: sell WBNB, buy WBNB, or stand down. */
  side: WeightSide;
  /** Notional to move, in USD. Zero when there is nothing to do. */
  usd: number;
}

/**
 * The whole decision, as a pure function of the two side values.
 *
 * Inside the band, nothing: rebalancing on every wobble pays a fee to chase
 * noise, which is exactly how a rebalancer loses money. Outside it, move the
 * distance to the target and no more. The result can never exceed the side
 * being sold, since the gap to a target weight is a fraction of the overweight
 * side by construction, so this can neither overdraw a leg nor cross the
 * balance point and create the opposite drift.
 */
export function planWeightTrade(input: {
  baseUsd: number;
  quoteUsd: number;
  targetWeight: number;
  bandPct: number;
}): WeightTrade {
  const { baseUsd, quoteUsd, targetWeight, bandPct } = input;
  // Rejects an absent book (nothing to weigh) and a corrupt one (negative or
  // non-finite side), so neither can size a swap.
  if (weightOfBase(baseUsd, quoteUsd) === null) return { side: 'none', usd: 0 };
  const gapUsd = valueGapUsd(baseUsd, quoteUsd, targetWeight);
  if (!Number.isFinite(gapUsd)) return { side: 'none', usd: 0 };
  // The band, compared in dollars rather than as a difference of weights. The
  // two are the same rule (the gap IS total * drift), but dividing to a weight
  // and multiplying back by 100 leaves a float artifact that pushes an exactly
  // at-the-band book over the line: 55/45 reads as 5.000000000000004 points.
  // Multiplying before dividing keeps the boundary exact, so drift equal to the
  // band holds, the same way the grid's halt bands are formulated.
  const bandUsd = ((baseUsd + quoteUsd) * bandPct) / 100;
  if (Math.abs(gapUsd) <= bandUsd) return { side: 'none', usd: 0 };
  return { side: gapUsd > 0 ? 'sell' : 'buy', usd: Math.abs(gapUsd) };
}

interface RebalanceRecord {
  at: string;
  side: 'buy' | 'sell';
  usd: number;
  price: number;
  orderUid: string;
}

export const weightRebalancerAgent: AgentModule = {
  name: 'weight-rebalancer',
  category: 'rebalancing',
  tickIntervalMs: TICK_INTERVAL_MS,

  async tick(ctx) {
    if (ctx.breakers.isHalted().halted) return;

    const pool = await resolveReferencePool(ctx, PAIR);
    const price = await readMidPrice(ctx, pool);
    const balances = await readBalances(ctx, PAIR);
    const wbnbWhole = Number(fromBaseUnits(balances.base, WBNB.decimals));
    const usdtWhole = Number(fromBaseUnits(balances.quote, USDT.decimals));
    const baseUsd = wbnbWhole * price;
    const totalUsd = inventoryValueUsd(wbnbWhole, usdtWhole, price);

    // Fail SAFE on a corrupt read: a non-finite price would make the weight
    // meaningless and could size a swap against garbage.
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(totalUsd) || totalUsd <= 0) {
      ctx.log({ event: 'bad-read', price, totalUsd });
      return;
    }

    const weight = weightOfBase(baseUsd, usdtWhole);
    const plan = planWeightTrade({
      baseUsd,
      quoteUsd: usdtWhole,
      targetWeight: TARGET_WEIGHT,
      bandPct: BAND_PCT,
    });
    if (plan.side === 'none') {
      ctx.log({
        event: 'tick',
        price,
        totalUsd,
        weight,
        targetWeight: TARGET_WEIGHT,
        driftPoints: weight === null ? null : driftPoints(weight, TARGET_WEIGHT),
      });
      return;
    }

    const now = Date.now();
    const lastRebalanceAt = ctx.state.get<number | null>('lastRebalanceAt', null);
    if (isCooldownActive(now, lastRebalanceAt, COOLDOWN_MS)) {
      ctx.log({ event: 'rebalance-blocked', reason: 'cooldown', weight, plannedUsd: plan.usd });
      return;
    }

    // Size to what the spending leg can actually fund. The plan is already
    // bounded by that side, so this only bites on a rounding edge or a balance
    // that moved between reads, and it only ever shrinks.
    const affordableUsd = plan.side === 'sell' ? baseUsd : usdtWhole;
    const tradeUsd = effectiveClipUsd(plan.usd, affordableUsd, MIN_TRADE_USD);
    // Catches both cases in one test: a plan under the floor, and a leg that
    // cannot fund even the floor (effectiveClipUsd returns the desired size
    // untouched when the wallet affords it, so the floor has to be applied
    // here as well as inside it).
    if (tradeUsd < MIN_TRADE_USD) {
      ctx.log({
        event: 'rebalance-skipped',
        reason: 'under-min-notional',
        weight,
        plannedUsd: plan.usd,
        affordableUsd,
        minTradeUsd: MIN_TRADE_USD,
      });
      return;
    }

    // Last, so a tick that was never going to trade cannot spend a daily slot.
    if (!ctx.breakers.allowAction('rebalance', MAX_REBALANCES_PER_DAY)) {
      ctx.log({ event: 'rebalance-skipped', reason: 'daily-cap', weight, plannedUsd: plan.usd });
      return;
    }

    const sellToken = plan.side === 'sell' ? WBNB : USDT;
    const buyToken = plan.side === 'sell' ? USDT : WBNB;
    const sellAmount =
      plan.side === 'sell' ? toSignificant(tradeUsd / price, 6) : toSignificant(tradeUsd, 6);
    const sellBaseUnits = toBaseUnits(sellAmount, sellToken.decimals);
    const balanceBaseUnits = plan.side === 'sell' ? balances.base : balances.quote;
    if (balanceBaseUnits < sellBaseUnits) {
      // Rounding up to 6 significant digits can land a hair above the balance.
      ctx.log({
        event: 'rebalance-blocked',
        reason: 'insufficient-balance',
        side: plan.side,
        sellAmount,
      });
      return;
    }

    ctx.log({
      event: 'rebalance-intent',
      side: plan.side,
      weight,
      targetWeight: TARGET_WEIGHT,
      driftPoints: weight === null ? null : driftPoints(weight, TARGET_WEIGHT),
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount,
      notionalUsd: tradeUsd,
      price,
      totalUsd,
    });

    // Persist the cooldown anchor BEFORE submitting. A crash in the submit
    // window must not lose it, or a restart would re-sign the same rebalance
    // while the first order was still live. The cost of the safe direction is
    // one deferred rebalance.
    ctx.state.set('lastRebalanceAt', now);

    const wallet = new ChassisOphisWallet(ctx.account, ctx.publicClient, ctx.walletClient);
    const result = await executeOphisSwap(
      wallet,
      {
        sellToken: sellToken.address,
        buyToken: buyToken.address,
        sellAmount,
        slippageBps: SLIPPAGE_BPS,
        minimumBuyAmount: independentMinimumBuyAmount({
          sellAmount,
          buyUnitsPerSellUnit: plan.side === 'sell' ? price : 1 / price,
          buyDecimals: buyToken.decimals,
        }),
      },
      {},
    );
    ctx.log({
      event: 'rebalance-submitted',
      orderUid: result.orderUid,
      side: plan.side,
      sellToken: sellToken.symbol,
      buyToken: buyToken.symbol,
      sellAmount,
      notionalUsd: tradeUsd,
      minBuyAmount: result.minBuyAmount,
      explorerUrl: result.explorerUrl,
      enrollmentWarning: result.enrollmentWarning ?? null,
    });

    const record: RebalanceRecord = {
      at: new Date().toISOString(),
      side: plan.side,
      usd: tradeUsd,
      price,
      orderUid: result.orderUid,
    };
    ctx.state.set(
      'rebalances',
      [...ctx.state.get<RebalanceRecord[]>('rebalances', []), record].slice(-HISTORY_LIMIT),
    );
  },

  async status(ctx) {
    const halted = ctx.breakers.isHalted();
    const rebalances = ctx.state.get<RebalanceRecord[]>('rebalances', []);
    const lastRebalanceAt = ctx.state.get<number | null>('lastRebalanceAt', null);

    let price: number | null = null;
    let totalUsd: number | null = null;
    let weight: number | null = null;
    let error: string | undefined;
    try {
      const pool = await resolveReferencePool(ctx, PAIR);
      price = await readMidPrice(ctx, pool);
      const balances = await readBalances(ctx, PAIR);
      const wbnbWhole = Number(fromBaseUnits(balances.base, WBNB.decimals));
      const usdtWhole = Number(fromBaseUnits(balances.quote, USDT.decimals));
      totalUsd = inventoryValueUsd(wbnbWhole, usdtWhole, price);
      weight = weightOfBase(wbnbWhole * price, usdtWhole);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      pair: 'WBNB/USDT',
      targetWeight: TARGET_WEIGHT,
      bandPct: BAND_PCT,
      weight,
      driftPoints: weight === null ? null : driftPoints(weight, TARGET_WEIGHT),
      price,
      totalUsd,
      maxRebalancesPerDay: MAX_REBALANCES_PER_DAY,
      cooldownMinutes: COOLDOWN_MS / 60_000,
      lastRebalanceAt: lastRebalanceAt === null ? null : new Date(lastRebalanceAt).toISOString(),
      rebalances: rebalances.slice(-10),
      halted,
      ...(error ? { error } : {}),
    };
  },
};
