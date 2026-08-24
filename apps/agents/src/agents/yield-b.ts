/**
 * yield-b: the second managed agent, competing with `yield` for the same
 * deposits on the same router with a deliberately slower policy.
 *
 * This is the change that makes funds under management a marketplace rather
 * than a product demo. The AgripinaaYieldRouter is per-token, un-owned, and
 * hardcodes every recipient to the calling account, so a second agent needs no
 * contract change and no new trust: it needs its own master manager key
 * (wallets/agent-yield-b-session.json) and `managed: true` on its record. A
 * depositor then picks a policy, and the two build separate track records on
 * the same market.
 *
 * Everything about HOW funds move is reused from ./yield unchanged: the same
 * two venues, the same measured block-cadence APY read (BSC block times moved
 * with Lorentz/Maxwell, so blocks-per-year is extrapolated rather than
 * assumed), the same supply and withdraw calls, and the same managed tick
 * driving one router action per account. Copying any of that would mean the
 * next fix to the incumbent silently missed this agent.
 *
 * What is this agent's own is WHEN funds move, which lives in ../yield-policy:
 * 120 bps of edge (against 50), three consecutive confirmations (against two),
 * a twelve hour check (against six), and at most one rotation every two days.
 * Both of its paths, its own capital and every managed mandate, run through the
 * same gate, so it cannot hold itself to a different standard than a depositor.
 */
import { fromBaseUnits } from '@agripinaa/shared';

import type { AgentContext, AgentModule } from '../types';
import {
  DUST_WEI,
  RESERVE_WEI,
  chooseFirstVenue,
  movesToday,
  readPosition,
  readRates,
  recordMove,
  supplyTo,
  withdrawAave,
  withdrawVenus,
  type Venue,
} from './yield';
import { YIELD_B_PARAMS, conservativeRotation, shouldRotate } from '../yield-policy';

export { YIELD_B_PARAMS, shouldRotate };

/** USDT is the only own-capital asset, matching the incumbent. */
const USDT_DECIMALS = 18;

/** Same ceiling as the incumbent, on top of the two-day floor. */
const MAX_ROTATIONS_PER_DAY = 1;

export const yieldBAgent: AgentModule = {
  name: 'yield-b',
  category: 'yield',
  tickIntervalMs: YIELD_B_PARAMS.tickIntervalMs,

  async tick(ctx) {
    const halted = ctx.breakers.isHalted();
    if (halted.halted) {
      ctx.log({ event: 'tick-skip', reason: `halted: ${halted.reason}` });
      return;
    }

    const rates = await readRates(ctx.publicClient);
    const position = await readPosition(ctx.publicClient, ctx.account.address);

    const storedVenue = ctx.state.get<Venue>('venue', 'none');
    const venue = position.chainVenue;
    if (venue !== storedVenue) {
      ctx.log({ event: 'venue-reconciled', stored: storedVenue, chain: venue });
      ctx.state.set('venue', venue);
    }

    const base = {
      venue,
      venusApyBps: rates.venusBps,
      aaveApyBps: rates.aaveBps,
      blocksPerYear: rates.blocksPerYear,
      thresholdBps: YIELD_B_PARAMS.thresholdBps,
      requiredWins: YIELD_B_PARAMS.requiredWins,
      walletUsdt: fromBaseUnits(position.walletUsdtWei, USDT_DECIMALS),
      venusUsdt: fromBaseUnits(position.venusUnderlyingWei, USDT_DECIMALS),
      aaveUsdt: fromBaseUnits(position.aaveATokenWei, USDT_DECIMALS),
    };

    if (venue === 'none') {
      // Entry is not a rotation: the floor and the confirmation count exist to
      // stop churn between venues, and neither should leave capital idle.
      const deployableWei = position.walletUsdtWei - RESERVE_WEI;
      if (deployableWei <= DUST_WEI) {
        ctx.log({
          ...base,
          event: 'tick',
          decision: 'unfunded',
          deployable: fromBaseUnits(
            deployableWei > BigInt(0) ? deployableWei : BigInt(0),
            USDT_DECIMALS,
          ),
        });
        return;
      }
      const target = chooseFirstVenue(rates.venusBps, rates.aaveBps);
      if (!ctx.breakers.allowAction('enter', 2)) {
        ctx.log({ ...base, event: 'tick', decision: 'enter-capped', target });
        return;
      }
      ctx.log({
        ...base,
        event: 'tick',
        decision: 'enter',
        target,
        amount: fromBaseUnits(deployableWei, USDT_DECIMALS),
      });
      await supplyTo(ctx, target, deployableWei);
      ctx.state.set('venue', target);
      ctx.state.set('betterStreak', 0);
      recordMove(ctx);
      return;
    }

    const decision = conservativeRotation({
      venue,
      venusBps: rates.venusBps,
      aaveBps: rates.aaveBps,
      betterStreak: ctx.state.get<number>('betterStreak', 0),
    });
    ctx.state.set('betterStreak', decision.nextStreak);

    if (decision.action === 'hold') {
      ctx.log({
        ...base,
        event: 'tick',
        decision: 'hold',
        edgeBps: decision.edgeBps,
        betterStreak: decision.nextStreak,
      });
      return;
    }

    // Checked before the daily counter, so a refused rotation costs no slot.
    const now = Date.now();
    const sinceLastRotateMs = now - ctx.state.get<number>('lastRotateAt', 0);
    if (sinceLastRotateMs < YIELD_B_PARAMS.minRotationIntervalMs) {
      ctx.log({
        ...base,
        event: 'tick',
        decision: 'rotate-cooldown',
        target: decision.target,
        edgeBps: decision.edgeBps,
        sinceLastRotateMs,
        minRotationIntervalMs: YIELD_B_PARAMS.minRotationIntervalMs,
      });
      return;
    }
    if (!ctx.breakers.allowAction('rotate', MAX_ROTATIONS_PER_DAY)) {
      ctx.log({
        ...base,
        event: 'tick',
        decision: 'rotate-capped',
        target: decision.target,
        edgeBps: decision.edgeBps,
      });
      return;
    }

    ctx.log({
      ...base,
      event: 'tick',
      decision: 'rotate',
      from: venue,
      to: decision.target,
      edgeBps: decision.edgeBps,
    });
    // Anchored before the withdraw, so a crash between the two legs cannot let
    // the next tick start a second rotation on top of a half-finished one.
    ctx.state.set('lastRotateAt', now);
    if (venue === 'venus') await withdrawVenus(ctx);
    else await withdrawAave(ctx);
    ctx.state.set('venue', 'none');

    const after = await readPosition(ctx.publicClient, ctx.account.address);
    const deployableWei = after.walletUsdtWei - RESERVE_WEI;
    if (deployableWei <= DUST_WEI) {
      ctx.log({
        event: 'rotate-abort',
        reason: 'nothing to redeploy after withdraw',
        wallet: fromBaseUnits(after.walletUsdtWei, USDT_DECIMALS),
      });
      return;
    }
    await supplyTo(ctx, decision.target, deployableWei);
    ctx.state.set('venue', decision.target);
    recordMove(ctx);
  },

  async status(ctx) {
    const [rates, position] = await Promise.all([
      readRates(ctx.publicClient),
      readPosition(ctx.publicClient, ctx.account.address),
    ]);
    const venue = position.chainVenue;
    const positionWei =
      venue === 'venus'
        ? position.venusUnderlyingWei
        : venue === 'aave'
          ? position.aaveATokenWei
          : BigInt(0);
    const edgeBps =
      venue === 'venus'
        ? rates.aaveBps - rates.venusBps
        : venue === 'aave'
          ? rates.venusBps - rates.aaveBps
          : Math.abs(rates.aaveBps - rates.venusBps);
    const lastRotateAt = ctx.state.get<number>('lastRotateAt', 0);
    return {
      venue,
      positionUsdt: fromBaseUnits(positionWei, USDT_DECIMALS),
      venusApyBps: rates.venusBps,
      aaveApyBps: rates.aaveBps,
      edgeBps,
      thresholdBps: YIELD_B_PARAMS.thresholdBps,
      requiredWins: YIELD_B_PARAMS.requiredWins,
      minHoursBetweenMoves: YIELD_B_PARAMS.minRotationIntervalMs / 3_600_000,
      betterStreak: ctx.state.get<number>('betterStreak', 0),
      hoursSinceLastMove: lastRotateAt > 0 ? (Date.now() - lastRotateAt) / 3_600_000 : null,
      movesToday: movesToday(ctx),
      halted: ctx.breakers.isHalted().halted,
    };
  },
};
