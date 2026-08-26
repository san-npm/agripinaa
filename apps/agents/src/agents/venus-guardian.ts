/**
 * Venus liquidation guardian on BSC.
 *
 * The second agent in the health-factor category, and the one that makes it a
 * category rather than a single-protocol demo: same repair policy as the Aave
 * guardian (warn at 1.5, act at 1.3, repay back to 1.6), a different lending
 * venue, and Venus is BSC native.
 *
 * All of the decision logic is reused, not re-derived. `planRepair`,
 * `scaleRepayToToken`, `classifyHf`, `evaluateThresholds` and `planRepayAmounts`
 * in ./health-factor are pure, integer-only, unit-tested, and protocol-agnostic
 * the moment you hand them a 1e18-scaled health factor. A second, float-based
 * planner living beside them would be a weaker copy that drifts the first time
 * one of the two is fixed.
 *
 * So the only new arithmetic here is that health factor, because Venus does not
 * publish one. `getAccountLiquidity` answers whether an account is underwater
 * (a shortfall) but not by what ratio, which is not enough to act BEFORE
 * liquidation, which is the entire job. The ratio is derived instead from
 * collateral value, borrow value, and the market collateral factor, which is
 * exactly what the comptroller itself computes a shortfall from. The two are
 * cross-checked on every tick (see shortfallAgreesWithHf): if our number and
 * the comptroller's ever disagree about solvency, one of them is reading the
 * position wrong and the log says so.
 *
 * Addresses are pinned here rather than configured, and verified on-chain
 * 2026-08-24 against https://bsc-rpc.publicnode.com (chain 56):
 *   Comptroller 0xfD36E2c2a6789Db23113685031d7F16329158384
 *   oracle()   => 0x6592b5DE802159F3E74B2486b091D11a8256ab8A (ResilientOracle)
 *   markets(vBNB)  => isListed, collateralFactorMantissa 0.80e18
 *   markets(vUSDT) => isListed, collateralFactorMantissa 0.80e18
 *   markets(vUSDC) => isListed, collateralFactorMantissa 0.825e18
 * The collateral factor is READ LIVE on every tick and the recorded values
 * above are only drift detection, because Venus governance can move a factor by
 * vote and a hardcoded 0.80 would then quietly misreport the health of an actual
 * position in the direction of doing nothing.
 *
 * This agent only ever ADDS value to the position: it repays, and it never
 * withdraws, redeems, or exits a market. There is deliberately no path here
 * that removes collateral from a venue where the account carries debt.
 */
import { TOKENS_BSC, fromBaseUnits } from '@agripinaa/shared';
import { erc20Abi, parseAbi } from 'viem';

import type { AgentContext, AgentModule } from '../types';
import {
  ACT_AT,
  MAX_UINT256,
  TARGET_HF,
  WARN_AT,
  evaluateThresholds,
  hfWadToNumber,
  planRepayAmounts,
  type HfZone,
} from './health-factor';

export const VENUS_COMPTROLLER = '0xfD36E2c2a6789Db23113685031d7F16329158384' as const;
export const VENUS_ORACLE = '0x6592b5DE802159F3E74B2486b091D11a8256ab8A' as const;
export const VENUS_VBNB = '0xA07c5b74C9B40447a954e1466938b865b6BBea36' as const;
export const VENUS_VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255' as const;
export const VENUS_VUSDC = '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8' as const;

const USDT = TOKENS_BSC['USDT']!;

const WAD = BigInt(10) ** BigInt(18);
const DAY_MS = 24 * 3600 * 1000;

/** Same ceiling as the Aave guardian: a repair loop, not a trading budget. */
export const MAX_REPAYS_PER_DAY = 6;

/**
 * The markets whose parameters are checked against the recorded values on every
 * tick, whether or not the account is in them. Reading them unconditionally is
 * what turns the addresses at the top of this file from a comment into an
 * assertion: a wrong comptroller address cannot answer `markets()` for all
 * three of these with the factors below.
 */
const RECORDED_MARKETS: readonly { vToken: `0x${string}`; collateralFactorMantissa: bigint }[] = [
  { vToken: VENUS_VBNB, collateralFactorMantissa: (WAD * BigInt(80)) / BigInt(100) },
  { vToken: VENUS_VUSDT, collateralFactorMantissa: (WAD * BigInt(80)) / BigInt(100) },
  { vToken: VENUS_VUSDC, collateralFactorMantissa: (WAD * BigInt(825)) / BigInt(1000) },
];

const comptrollerAbi = parseAbi([
  'function getAssetsIn(address account) view returns (address[])',
  'function getAccountLiquidity(address account) view returns (uint256, uint256, uint256)',
  'function markets(address vToken) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)',
  'function oracle() view returns (address)',
]);

/** Prices are scaled to 1e(36 - underlying decimals), so amount * price / 1e18 is USD in 1e18. */
const oracleAbi = parseAbi([
  'function getUnderlyingPrice(address vToken) view returns (uint256)',
]);

/**
 * balanceOfUnderlying and borrowBalanceCurrent both accrue interest before
 * returning, so Solidity marks them nonpayable. They are only ever reached here
 * through eth_call, where accrual is discarded and the return value is the
 * up-to-date figure; declaring them view lets readContract accept them. Same
 * treatment as agents/yield.ts gives balanceOfUnderlying.
 */
const vTokenReadAbi = parseAbi([
  'function balanceOfUnderlying(address owner) view returns (uint256)',
  'function borrowBalanceCurrent(address account) view returns (uint256)',
]);

/** Compound forks signal failure with a returned error code, not a revert. */
const vTokenWriteAbi = parseAbi([
  'function repayBorrow(uint256 repayAmount) returns (uint256)',
]);

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested, no network)
// ---------------------------------------------------------------------------

/**
 * The health factor Venus does not publish, on the 1e18 scale Aave uses so the
 * existing planner can consume it unchanged.
 *
 * HF = (collateral value * collateral factor) / borrow value. Both values are
 * 1e18-scaled USD and the factor is a 1e18 mantissa, so the two dollar scales
 * cancel and the result is already 1e18-scaled.
 *
 * No debt returns Aave's no-debt sentinel (type(uint256).max) so planRepair
 * short-circuits on it exactly as it does for an Aave account. Debt with no
 * eligible collateral behind it returns 0 rather than the sentinel: that
 * position is liquidatable right now, and reporting it as "no risk" is the one
 * failure mode a guardian must not have.
 */
export function venusHfWad(input: {
  collateralUsdWad: bigint;
  borrowUsdWad: bigint;
  collateralFactorMantissa: bigint;
}): bigint {
  if (input.borrowUsdWad <= BigInt(0)) return MAX_UINT256;
  if (input.collateralUsdWad <= BigInt(0)) return BigInt(0);
  if (input.collateralFactorMantissa <= BigInt(0)) return BigInt(0);
  return (input.collateralUsdWad * input.collateralFactorMantissa) / input.borrowUsdWad;
}

/** One Venus market the account has entered, already priced. */
export interface VenusMarketLeg {
  vToken: `0x${string}`;
  /** Supplied underlying valued in USD, 1e18-scaled. */
  suppliedUsdWad: bigint;
  /** Borrowed underlying valued in USD, 1e18-scaled. */
  borrowUsdWad: bigint;
  /** markets(vToken).collateralFactorMantissa, or 0 for a market that is not listed. */
  collateralFactorMantissa: bigint;
}

export interface VenusAggregate {
  collateralUsdWad: bigint;
  borrowUsdWad: bigint;
  /** Value-weighted across the legs, so venusHfWad takes a single factor. */
  collateralFactorMantissa: bigint;
}

/**
 * Fold every entered market into the single (collateral, borrow, factor) triple
 * venusHfWad takes.
 *
 * An account can hold collateral in several markets at different factors, and
 * the comptroller measures borrowing power as sum(value * factor). Folding to
 * one weighted factor keeps that sum intact: sum(v*f)/sum(v) multiplied back by
 * sum(v) is the same number, up to the one wei the integer division can drop
 * off the mantissa, which moves the health factor by about 1e-18 and always
 * downward, i.e. toward acting sooner.
 */
export function aggregateVenusPosition(legs: readonly VenusMarketLeg[]): VenusAggregate {
  let collateralUsdWad = BigInt(0);
  let borrowUsdWad = BigInt(0);
  let borrowingPower = BigInt(0);
  for (const leg of legs) {
    collateralUsdWad += leg.suppliedUsdWad;
    borrowUsdWad += leg.borrowUsdWad;
    borrowingPower += leg.suppliedUsdWad * leg.collateralFactorMantissa;
  }
  return {
    collateralUsdWad,
    borrowUsdWad,
    collateralFactorMantissa:
      collateralUsdWad > BigInt(0) ? borrowingPower / collateralUsdWad : BigInt(0),
  };
}

/**
 * Rounding at the boundary is not evidence of a bad read, so a health factor
 * within 1e-9 of 1.0 is treated as consistent with either answer.
 */
const HF_BOUNDARY_TOLERANCE_WAD = BigInt(10) ** BigInt(9);

/**
 * Does our derived health factor agree with the comptroller's own verdict?
 *
 * Venus reports solvency as a shortfall in USD, we report it as a ratio, and
 * the two are computed from the same collateral, debt, and factors. They must
 * therefore agree on the only question both answer: is this account under
 * water. A disagreement means one of the two is reading the position wrong, and
 * on a guardian that is worth a line in the log rather than silence.
 */
export function shortfallAgreesWithHf(hfWad: bigint, shortfallWad: bigint): boolean {
  const underwaterPerVenus = shortfallWad > BigInt(0);
  if (hfWad === MAX_UINT256) return !underwaterPerVenus;
  const distance = hfWad > WAD ? hfWad - WAD : WAD - hfWad;
  if (distance <= HF_BOUNDARY_TOLERANCE_WAD) return true;
  return underwaterPerVenus === hfWad < WAD;
}

function serializeHf(hf: number): number | string {
  return Number.isFinite(hf) ? hf : 'Infinity';
}

// ---------------------------------------------------------------------------
// Chain access
// ---------------------------------------------------------------------------

interface MarketInfo {
  isListed: boolean;
  collateralFactorMantissa: bigint;
}

interface VenusPosition extends VenusAggregate {
  legs: VenusMarketLeg[];
  hfWad: bigint;
  /** Borrowed USDT in token units, which is what a repay is denominated in. */
  usdtDebtWei: bigint;
  liquidityWad: bigint;
  shortfallWad: bigint;
}

async function readMarket(
  ctx: AgentContext,
  vToken: `0x${string}`,
): Promise<MarketInfo> {
  const [isListed, collateralFactorMantissa] = await ctx.publicClient.readContract({
    address: VENUS_COMPTROLLER,
    abi: comptrollerAbi,
    functionName: 'markets',
    args: [vToken],
  });
  return { isListed, collateralFactorMantissa };
}

/**
 * Confirm the recorded markets still look like the ones this agent was written
 * against, and report drift rather than acting on it.
 *
 * A moved collateral factor or a rotated oracle is a governance decision, not a
 * fault: refusing to guard through either would take the agent offline exactly
 * when a parameter change is repricing the position, which is when a borrower
 * most needs it. So both are logged and the LIVE value is what gets used.
 */
async function auditRecordedMarkets(ctx: AgentContext): Promise<void> {
  for (const recorded of RECORDED_MARKETS) {
    const live = await readMarket(ctx, recorded.vToken);
    if (!live.isListed) {
      ctx.log({
        event: 'venus-market-delisted',
        level: 'warn',
        vToken: recorded.vToken,
      });
      continue;
    }
    if (live.collateralFactorMantissa !== recorded.collateralFactorMantissa) {
      ctx.log({
        event: 'venus-collateral-factor-drift',
        level: 'warn',
        vToken: recorded.vToken,
        recorded: recorded.collateralFactorMantissa.toString(),
        live: live.collateralFactorMantissa.toString(),
      });
    }
  }
}

async function readVenusPosition(ctx: AgentContext): Promise<VenusPosition> {
  const self = ctx.account.address;
  const [entered, oracle, liquidity] = await Promise.all([
    ctx.publicClient.readContract({
      address: VENUS_COMPTROLLER,
      abi: comptrollerAbi,
      functionName: 'getAssetsIn',
      args: [self],
    }),
    ctx.publicClient.readContract({
      address: VENUS_COMPTROLLER,
      abi: comptrollerAbi,
      functionName: 'oracle',
    }),
    ctx.publicClient.readContract({
      address: VENUS_COMPTROLLER,
      abi: comptrollerAbi,
      functionName: 'getAccountLiquidity',
      args: [self],
    }),
  ]);

  const [liquidityError, liquidityWad, shortfallWad] = liquidity;
  if (liquidityError !== BigInt(0)) {
    // Venus returns a nonzero code when it cannot price the account (a failed
    // oracle, most often). Any health factor derived alongside it is unsound.
    throw new Error(`venus getAccountLiquidity error ${liquidityError}`);
  }
  if (oracle.toLowerCase() !== VENUS_ORACLE.toLowerCase()) {
    ctx.log({ event: 'venus-oracle-rotated', level: 'warn', recorded: VENUS_ORACLE, live: oracle });
  }

  await auditRecordedMarkets(ctx);

  const legs: VenusMarketLeg[] = [];
  let usdtDebtWei = BigInt(0);
  for (const vToken of entered) {
    const [market, price, supplied, borrowed] = await Promise.all([
      readMarket(ctx, vToken),
      ctx.publicClient.readContract({
        address: oracle,
        abi: oracleAbi,
        functionName: 'getUnderlyingPrice',
        args: [vToken],
      }),
      ctx.publicClient.readContract({
        address: vToken,
        abi: vTokenReadAbi,
        functionName: 'balanceOfUnderlying',
        args: [self],
      }),
      ctx.publicClient.readContract({
        address: vToken,
        abi: vTokenReadAbi,
        functionName: 'borrowBalanceCurrent',
        args: [self],
      }),
    ]);
    if (price === BigInt(0)) {
      // A zero price zeroes this market's debt as well as its collateral, which
      // would read as a healthier position than the actual one. Stop.
      throw new Error(`venus reported a zero oracle price for ${vToken}`);
    }
    if (!market.isListed) {
      // The comptroller gives an unlisted market no borrowing power, so neither
      // do we. Its debt still counts.
      ctx.log({ event: 'venus-market-unlisted', level: 'warn', vToken });
    }
    if (vToken.toLowerCase() === VENUS_VUSDT.toLowerCase()) usdtDebtWei = borrowed;
    legs.push({
      vToken,
      suppliedUsdWad: (supplied * price) / WAD,
      borrowUsdWad: (borrowed * price) / WAD,
      collateralFactorMantissa: market.isListed ? market.collateralFactorMantissa : BigInt(0),
    });
  }

  const aggregate = aggregateVenusPosition(legs);
  return {
    ...aggregate,
    legs,
    hfWad: venusHfWad(aggregate),
    usdtDebtWei,
    liquidityWad,
    shortfallWad,
  };
}

async function readUsdtBalance(ctx: AgentContext): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ctx.account.address],
  });
}

async function ensureAllowance(ctx: AgentContext, amount: bigint): Promise<void> {
  const current = await ctx.publicClient.readContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.account.address, VENUS_VUSDT],
  });
  if (current >= amount) return;
  const hash = await ctx.walletClient.writeContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: 'approve',
    args: [VENUS_VUSDT, amount],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  ctx.log({ event: 'approve', token: USDT.address, spender: VENUS_VUSDT, amount: String(amount), txHash: hash });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`approve reverted: ${hash}`);
}

// ---------------------------------------------------------------------------
// Repair: repay USDT to lift the derived health factor back to TARGET_HF
// ---------------------------------------------------------------------------

async function runRepair(ctx: AgentContext, position: VenusPosition): Promise<void> {
  const usdtBalance = await readUsdtBalance(ctx);
  // planRepayAmounts is the Aave guardian's sizing, unchanged: target math,
  // proportional token scaling, wallet-budget cap. totalDebtBase is USD in
  // 1e18 here rather than Aave's 8-decimal base currency, which the function
  // does not care about: it only ever uses the debt figures as a ratio.
  const plan = planRepayAmounts({
    hfWad: position.hfWad,
    totalDebtBase: position.borrowUsdWad,
    usdtDebt: position.usdtDebtWei,
    usdtBalance,
    targetHf: TARGET_HF,
  });
  ctx.log({
    event: 'repair-plan',
    repayBase: String(plan.repayBase),
    repayUsdt: fromBaseUnits(plan.repayUsdt, USDT.decimals),
    usdtDebt: fromBaseUnits(position.usdtDebtWei, USDT.decimals),
    usdtBalance: fromBaseUnits(usdtBalance, USDT.decimals),
    cappedByBudget: plan.cappedByBudget,
  });

  if (position.usdtDebtWei === BigInt(0)) {
    // The budget is USDT, so a borrow in anything else is outside what this
    // agent can repair. Say so: a silent zero-repay reads as "nothing to do"
    // on a position that is heading for liquidation.
    ctx.log({
      event: 'repair-skip',
      level: 'warn',
      reason: 'no-usdt-debt',
      note: 'position is under the act threshold but none of the debt is USDT',
    });
    return;
  }
  if (usdtBalance === BigInt(0)) {
    ctx.log({ event: 'budget-exhausted', level: 'warn', note: 'no USDT to repay with; monitoring continues' });
    return;
  }
  if (plan.repayUsdt <= BigInt(0)) {
    ctx.log({ event: 'repair-skip', reason: 'zero-repay-amount' });
    return;
  }
  if (!ctx.breakers.allowAction('repay', MAX_REPAYS_PER_DAY)) {
    ctx.log({ event: 'repair-skip', reason: 'action-cap', maxPerDay: MAX_REPAYS_PER_DAY });
    return;
  }

  await ensureAllowance(ctx, plan.repayUsdt);
  const { result, request } = await ctx.publicClient.simulateContract({
    address: VENUS_VUSDT,
    abi: vTokenWriteAbi,
    functionName: 'repayBorrow',
    args: [plan.repayUsdt],
    account: ctx.account,
  });
  if (result !== BigInt(0)) throw new Error(`venus repayBorrow would fail with code ${result}`);
  const hash = await ctx.walletClient.writeContract({ ...request, chain: ctx.walletClient.chain });
  ctx.log({ event: 'repay', txHash: hash });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`venus repayBorrow reverted: ${hash}`);

  const now = Date.now();
  const repayTimes = ctx.state.get<number[]>('repayTimes', []).filter((t) => t > now - DAY_MS);
  ctx.state.set('repayTimes', [...repayTimes, now]);
  ctx.log({
    event: 'repair-done',
    txHash: hash,
    repaidUsdt: fromBaseUnits(plan.repayUsdt, USDT.decimals),
  });
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const venusGuardianAgent: AgentModule = {
  name: 'venus-guardian',
  category: 'health-factor',
  tickIntervalMs: 60_000,

  async tick(ctx) {
    if (ctx.breakers.isHalted().halted) return;

    // No setup step, deliberately. The Aave guardian opens its own demo
    // position because it was the first of its kind and needed something to
    // guard; this one adopts whatever Venus position the wallet already holds
    // and reports plainly when there is none, rather than borrowing on its
    // own initiative. Opening a leveraged position is a funding decision.
    const position = await readVenusPosition(ctx);
    const hf = hfWadToNumber(position.hfWad);
    const prevZone = ctx.state.get<HfZone>('hfZone', 'healthy');
    const decision = evaluateThresholds(prevZone, hf, WARN_AT, ACT_AT);

    ctx.log({
      event: 'hf',
      hf: serializeHf(hf),
      zone: decision.zone,
      markets: position.legs.length,
      collateralUsd: fromBaseUnits(position.collateralUsdWad, 18),
      debtUsd: fromBaseUnits(position.borrowUsdWad, 18),
      collateralFactor: position.collateralFactorMantissa.toString(),
      shortfallUsd: fromBaseUnits(position.shortfallWad, 18),
    });
    if (!shortfallAgreesWithHf(position.hfWad, position.shortfallWad)) {
      ctx.log({
        event: 'venus-liquidity-disagreement',
        level: 'warn',
        hf: serializeHf(hf),
        shortfallUsd: fromBaseUnits(position.shortfallWad, 18),
        liquidityUsd: fromBaseUnits(position.liquidityWad, 18),
      });
    }
    if (decision.zone !== prevZone) ctx.state.set('hfZone', decision.zone);
    if (decision.emitWarn) {
      ctx.log({ event: 'hf-warn', level: 'warn', hf: serializeHf(hf), warnAt: WARN_AT });
    }
    if (decision.shouldRepair) await runRepair(ctx, position);
  },

  async status(ctx) {
    const [position, usdtBalance] = await Promise.all([
      readVenusPosition(ctx),
      readUsdtBalance(ctx),
    ]);
    const dayAgo = Date.now() - DAY_MS;
    const actionsToday = ctx.state.get<number[]>('repayTimes', []).filter((t) => t > dayAgo).length;
    return {
      protocol: 'venus',
      healthFactor: serializeHf(hfWadToNumber(position.hfWad)),
      warnAt: WARN_AT,
      actAt: ACT_AT,
      targetAfterRepair: TARGET_HF,
      collateralUsd: fromBaseUnits(position.collateralUsdWad, 18),
      debtUsd: fromBaseUnits(position.borrowUsdWad, 18),
      usdtDebt: fromBaseUnits(position.usdtDebtWei, USDT.decimals),
      collateralFactor: position.collateralFactorMantissa.toString(),
      marketsEntered: position.legs.length,
      shortfallUsd: fromBaseUnits(position.shortfallWad, 18),
      repayBudgetUsdt: fromBaseUnits(usdtBalance, USDT.decimals),
      maxRepaysPerDay: MAX_REPAYS_PER_DAY,
      actionsToday,
      halted: ctx.breakers.isHalted().halted,
    };
  },
};
