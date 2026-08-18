/**
 * Aave V3 BSC liquidation guardian (self-demo position).
 *
 * One-time setup supplies 0.004 WBNB and borrows 0.8 USDT variable, then every
 * tick reads getUserAccountData and repairs the health factor by repaying USDT
 * whenever HF drops below ACT_AT (the operator can push HF down by borrowing
 * more from the same wallet; the agent detects and repairs on the next tick).
 */
import { TOKENS_BSC, fromBaseUnits, toBaseUnits } from '@agripinaa/shared';
import { erc20Abi, parseAbi } from 'viem';

import type { AgentContext, AgentModule } from '../types';

// ---------------------------------------------------------------------------
// Verified protocol addresses (probe run 2026-08-18 against
// https://bsc-rpc.publicnode.com, chain 56):
//   provider.getPool()              => 0x6807dc923806fE8Fd134338EABCA509979a7e0cB (matches POOL below)
//   provider.getMarketId()          => "Aave V3 BNB Market"
//   pool.ADDRESSES_PROVIDER()       => 0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D (matches PROVIDER below)
//   pool.getReserveData(USDT)       => aToken 0xa9251ca9DE909CB71783723713B21E4233fbf1B1 ("aBnbUSDT"),
//                                      variableDebt 0xF8bb2Be50647447Fb355e3a77b81be4db64107cd, id 5
//   pool.getReserveData(WBNB)       => aToken 0x9B00a09492a626678E5A3009982191586C444Df9 ("aBnbWBNB"), id 1
//   pool.getUserAccountData(0x..01) => healthFactor = type(uint256).max for a no-debt account
// ---------------------------------------------------------------------------
export const AAVE_V3_BSC_PROVIDER =
  '0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D' as const;
export const AAVE_V3_BSC_POOL =
  '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' as const;

const WBNB = TOKENS_BSC.WBNB!;
const USDT = TOKENS_BSC.USDT!;

export const WARN_AT = 1.5;
export const ACT_AT = 1.3;
export const TARGET_HF = 1.6;
const SUPPLY_WBNB = '0.004';
const BORROW_USDT = '0.8';
// Aave interestRateMode 2 = variable.
const VARIABLE_RATE_MODE = BigInt(2);
const MAX_REPAYS_PER_DAY = 6;
const DAY_MS = 24 * 3600 * 1000;

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested, no network)
// ---------------------------------------------------------------------------

export const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

/** Aave returns HF 1e18-scaled, with type(uint256).max meaning "no debt". */
export function hfWadToNumber(hfWad: bigint): number {
  if (hfWad === MAX_UINT256) return Infinity;
  return Number(hfWad) / 1e18;
}

function hfNumberToWad(hf: number): bigint {
  return BigInt(Math.round(hf * 1e6)) * (BigInt(10) ** BigInt(12));
}

/**
 * Base-currency amount to repay so that HF lands on targetHf.
 * HF = collateral*LT/debt and collateral is untouched by a wallet repay, so
 * newDebt = debt*hf/target and repay = debt - newDebt. Zero when there is no
 * debt, HF is already at or above target, or HF is Infinity.
 */
export function planRepair(hfRay: bigint, totalDebtBase: bigint, targetHf: number): bigint {
  if (totalDebtBase <= BigInt(0)) return BigInt(0);
  if (hfRay === MAX_UINT256) return BigInt(0);
  const targetWad = hfNumberToWad(targetHf);
  if (targetWad <= BigInt(0)) return BigInt(0);
  if (hfRay >= targetWad) return BigInt(0);
  return totalDebtBase - (totalDebtBase * hfRay) / targetWad;
}

/** Convert a base-currency repay amount into token units, proportionally to the token's share of the debt. */
export function scaleRepayToToken(
  repayBase: bigint,
  totalDebtBase: bigint,
  tokenDebt: bigint,
): bigint {
  if (totalDebtBase <= BigInt(0) || repayBase <= BigInt(0)) return BigInt(0);
  const capped = repayBase > totalDebtBase ? totalDebtBase : repayBase;
  return (tokenDebt * capped) / totalDebtBase;
}

export interface RepayPlan {
  repayBase: bigint;
  repayUsdt: bigint;
  cappedByBudget: boolean;
}

/** Full repay sizing: target math, proportional token scaling, wallet-budget cap. */
export function planRepayAmounts(input: {
  hfWad: bigint;
  totalDebtBase: bigint;
  usdtDebt: bigint;
  usdtBalance: bigint;
  targetHf: number;
}): RepayPlan {
  const repayBase = planRepair(input.hfWad, input.totalDebtBase, input.targetHf);
  const wanted = scaleRepayToToken(repayBase, input.totalDebtBase, input.usdtDebt);
  const cappedByBudget = wanted > input.usdtBalance;
  const repayUsdt = cappedByBudget ? input.usdtBalance : wanted;
  return { repayBase, repayUsdt, cappedByBudget };
}

export type HfZone = 'healthy' | 'warn' | 'act';

const ZONE_SEVERITY: Record<HfZone, number> = { healthy: 0, warn: 1, act: 2 };

export function classifyHf(hf: number, warnAt: number, actAt: number): HfZone {
  if (hf < actAt) return 'act';
  if (hf < warnAt) return 'warn';
  return 'healthy';
}

export interface ThresholdDecision {
  zone: HfZone;
  /** Emit the warn log only on a downward crossing into the warn zone. */
  emitWarn: boolean;
  shouldRepair: boolean;
}

export function evaluateThresholds(
  prevZone: HfZone,
  hf: number,
  warnAt: number,
  actAt: number,
): ThresholdDecision {
  const zone = classifyHf(hf, warnAt, actAt);
  const emitWarn =
    zone === 'warn' && ZONE_SEVERITY[prevZone] < ZONE_SEVERITY[zone];
  return { zone, emitWarn, shouldRepair: zone === 'act' };
}

function serializeHf(hf: number): number | string {
  return Number.isFinite(hf) ? hf : 'Infinity';
}

// ---------------------------------------------------------------------------
// Chain access
// ---------------------------------------------------------------------------

interface AccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  healthFactor: bigint;
}

async function readAccountData(ctx: AgentContext): Promise<AccountData> {
  const [totalCollateralBase, totalDebtBase, , , , healthFactor] =
    await ctx.publicClient.readContract({
      address: AAVE_V3_BSC_POOL,
      abi: POOL_ABI,
      functionName: 'getUserAccountData',
      args: [ctx.account.address],
    });
  return { totalCollateralBase, totalDebtBase, healthFactor };
}

async function readErc20Balance(
  ctx: AgentContext,
  token: `0x${string}`,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ctx.account.address],
  });
}

async function confirmTx(
  ctx: AgentContext,
  label: string,
  hash: `0x${string}`,
): Promise<`0x${string}`> {
  ctx.log({ event: label, txHash: hash });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label} reverted: ${hash}`);
  }
  return hash;
}

async function ensureAllowance(
  ctx: AgentContext,
  token: `0x${string}`,
  amount: bigint,
): Promise<void> {
  const current = await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.account.address, AAVE_V3_BSC_POOL],
  });
  if (current >= amount) return;
  const hash = await ctx.walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [AAVE_V3_BSC_POOL, amount],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  ctx.log({ event: 'approve', token, spender: AAVE_V3_BSC_POOL, amount: String(amount), txHash: hash });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`approve reverted: ${hash}`);
}

// ---------------------------------------------------------------------------
// Setup: supply 0.004 WBNB, borrow 0.8 USDT variable
// ---------------------------------------------------------------------------

async function runSetup(ctx: AgentContext): Promise<boolean> {
  const acct = await readAccountData(ctx);
  const needSupply = acct.totalCollateralBase === BigInt(0);
  const needBorrow = acct.totalDebtBase === BigInt(0);
  if (!needSupply && !needBorrow) {
    ctx.state.set('setupDone', true);
    ctx.log({ event: 'setup-complete', note: 'existing position adopted' });
    return true;
  }

  const supplyWei = toBaseUnits(SUPPLY_WBNB, WBNB.decimals);
  if (needSupply) {
    const wbnbBalance = await readErc20Balance(ctx, WBNB.address);
    if (wbnbBalance < supplyWei) {
      ctx.log({
        event: 'setup-skip',
        reason: 'insufficient-wbnb',
        needed: SUPPLY_WBNB,
        balance: fromBaseUnits(wbnbBalance, WBNB.decimals),
      });
      return false;
    }
  }

  // allowAction records on allow, so it runs only after the balance gate.
  if (!ctx.breakers.allowAction('setup', 1)) {
    ctx.log({ event: 'setup-skip', reason: 'action-cap' });
    return false;
  }

  if (needSupply) {
    await ensureAllowance(ctx, WBNB.address, supplyWei);
    const hash = await ctx.walletClient.writeContract({
      address: AAVE_V3_BSC_POOL,
      abi: POOL_ABI,
      functionName: 'supply',
      args: [WBNB.address, supplyWei, ctx.account.address, 0],
      account: ctx.account,
      chain: ctx.walletClient.chain,
    });
    await confirmTx(ctx, 'supply', hash);
  }
  if (needBorrow) {
    const borrowWei = toBaseUnits(BORROW_USDT, USDT.decimals);
    const hash = await ctx.walletClient.writeContract({
      address: AAVE_V3_BSC_POOL,
      abi: POOL_ABI,
      functionName: 'borrow',
      args: [USDT.address, borrowWei, VARIABLE_RATE_MODE, 0, ctx.account.address],
      account: ctx.account,
      chain: ctx.walletClient.chain,
    });
    await confirmTx(ctx, 'borrow', hash);
  }
  ctx.state.set('setupDone', true);
  ctx.log({ event: 'setup-complete', suppliedWbnb: SUPPLY_WBNB, borrowedUsdt: BORROW_USDT });
  return true;
}

// ---------------------------------------------------------------------------
// Repair: repay USDT to lift HF back to TARGET_HF
// ---------------------------------------------------------------------------

async function runRepair(ctx: AgentContext, acct: AccountData): Promise<void> {
  const reserve = await ctx.publicClient.readContract({
    address: AAVE_V3_BSC_POOL,
    abi: POOL_ABI,
    functionName: 'getReserveData',
    args: [USDT.address],
  });
  const [usdtDebt, usdtBalance] = await Promise.all([
    readErc20Balance(ctx, reserve.variableDebtTokenAddress),
    readErc20Balance(ctx, USDT.address),
  ]);

  const plan = planRepayAmounts({
    hfWad: acct.healthFactor,
    totalDebtBase: acct.totalDebtBase,
    usdtDebt,
    usdtBalance,
    targetHf: TARGET_HF,
  });
  ctx.log({
    event: 'repair-plan',
    repayBase: String(plan.repayBase),
    repayUsdt: fromBaseUnits(plan.repayUsdt, USDT.decimals),
    usdtDebt: fromBaseUnits(usdtDebt, USDT.decimals),
    usdtBalance: fromBaseUnits(usdtBalance, USDT.decimals),
    cappedByBudget: plan.cappedByBudget,
  });

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

  await ensureAllowance(ctx, USDT.address, plan.repayUsdt);
  const sent = await ctx.walletClient.writeContract({
    address: AAVE_V3_BSC_POOL,
    abi: POOL_ABI,
    functionName: 'repay',
    args: [USDT.address, plan.repayUsdt, VARIABLE_RATE_MODE, ctx.account.address],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  const hash = await confirmTx(ctx, 'repay', sent);

  const now = Date.now();
  const repayTimes = ctx.state
    .get<number[]>('repayTimes', [])
    .filter((t) => t > now - DAY_MS);
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

export const healthFactorAgent: AgentModule = {
  name: 'health-factor',
  category: 'health-factor',
  tickIntervalMs: 60_000,

  async tick(ctx) {
    if (ctx.breakers.isHalted().halted) return;

    if (!ctx.state.get('setupDone', false)) {
      const ready = await runSetup(ctx);
      if (!ready) return;
    }

    const acct = await readAccountData(ctx);
    const hf = hfWadToNumber(acct.healthFactor);
    const prevZone = ctx.state.get<HfZone>('hfZone', 'healthy');
    const decision = evaluateThresholds(prevZone, hf, WARN_AT, ACT_AT);

    ctx.log({
      event: 'hf',
      hf: serializeHf(hf),
      zone: decision.zone,
      collateralBase: String(acct.totalCollateralBase),
      debtBase: String(acct.totalDebtBase),
    });
    if (decision.zone !== prevZone) ctx.state.set('hfZone', decision.zone);
    if (decision.emitWarn) {
      ctx.log({ event: 'hf-warn', level: 'warn', hf: serializeHf(hf), warnAt: WARN_AT });
    }
    if (decision.shouldRepair) await runRepair(ctx, acct);
  },

  async status(ctx) {
    const [acct, usdtBalance] = await Promise.all([
      readAccountData(ctx),
      readErc20Balance(ctx, USDT.address),
    ]);
    const hf = hfWadToNumber(acct.healthFactor);
    const dayAgo = Date.now() - DAY_MS;
    const actionsToday = ctx.state
      .get<number[]>('repayTimes', [])
      .filter((t) => t > dayAgo).length;
    return {
      healthFactor: serializeHf(hf),
      warnAt: WARN_AT,
      actAt: ACT_AT,
      targetAfterRepair: TARGET_HF,
      collateralBase: String(acct.totalCollateralBase),
      debtBase: String(acct.totalDebtBase),
      repayBudgetUsdt: fromBaseUnits(usdtBalance, USDT.decimals),
      actionsToday,
      halted: ctx.breakers.isHalted().halted,
    };
  },
};
