import { TOKENS_BSC, fromBaseUnits, toBaseUnits, type TokenInfo } from '@agripinaa/shared';
import { erc20Abi, maxUint256, parseAbi, type PublicClient } from 'viem';

import type { ManagedExecutor } from '../executor';
import type { AgentContext, AgentModule } from '../types';

export type Venue = 'none' | 'venus' | 'aave';

function requireToken(symbol: string): TokenInfo {
  const token = TOKENS_BSC[symbol];
  if (!token) throw new Error(`TOKENS_BSC is missing ${symbol}`);
  return token;
}

const USDT = requireToken('USDT');

/**
 * Probed 2026-08-18 via https://bsc-rpc.publicnode.com (block 116702525):
 *   underlying() == 0x55d398326f99059fF775485246999027B3197955 (BSC USDT, matches TOKENS_BSC)
 *   symbol() == "vUSDT", supplyRatePerBlock() == 288440988 (~202 bps APR at measured cadence)
 */
const VENUS_VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255' as const;

/**
 * Probed 2026-08-18 via https://bsc-rpc.publicnode.com (block 116702525):
 *   PoolAddressesProvider 0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D.getPool() == this pool
 *   pool.ADDRESSES_PROVIDER() round-trips to that provider
 *   getReserveData(USDT).currentLiquidityRate == 20677442659781966265526085 (~207 bps APR)
 *   getReserveData(USDT).aTokenAddress == 0xa9251ca9DE909CB71783723713B21E4233fbf1B1
 *     ("Aave BNB Smart Chain USDT" / aBnbUSDT, UNDERLYING_ASSET_ADDRESS == USDT,
 *      POOL == this pool, totalSupply ~60.1M USDT)
 */
const AAVE_POOL = '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' as const;

// Compound-fork vTokens signal failure through a returned error code, not a
// revert, so every mint/redeem is simulated and its return value checked.
const vTokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function supplyRatePerBlock() view returns (uint256)',
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
]);

// The vToken marks balanceOfUnderlying nonpayable, but it is a pure
// computation over stored state and is only ever exercised via eth_call;
// declaring it view here lets readContract accept it.
const vTokenReadAbi = parseAbi([
  'function balanceOfUnderlying(address owner) view returns (uint256)',
]);

const aavePoolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

const WAD = BigInt(10) ** BigInt(18);
const RAY = BigInt(10) ** BigInt(27);
const YEAR_SECONDS = 365 * 24 * 3600;

// Kept liquid for x402 demo payments, per spec.
export const RESERVE_WEI = toBaseUnits('0.1', USDT.decimals);
export const DUST_WEI = toBaseUnits('0.01', USDT.decimals);

export const HYSTERESIS_BPS = 50;
export const REQUIRED_STREAK = 2;

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested, no network)
// ---------------------------------------------------------------------------

/**
 * BSC block cadence changed with the Lorentz/Maxwell upgrades (measured
 * ~0.45s on 2026-08-18, not the historical 3s), so blocks-per-year is
 * extrapolated from two observed block timestamps instead of assumed.
 */
export function deriveBlocksPerYear(
  latestTimestamp: bigint,
  olderTimestamp: bigint,
  blockSpan: number,
): number {
  const elapsed = Number(latestTimestamp - olderTimestamp);
  if (elapsed <= 0 || blockSpan <= 0) {
    throw new Error(`cannot derive block cadence: elapsed=${elapsed}s span=${blockSpan}`);
  }
  return Math.round((YEAR_SECONDS * blockSpan) / elapsed);
}

/** Venus quotes a WAD-scaled per-block rate; simple APR (rate * blocks) in bps. */
export function venusApyBps(supplyRatePerBlock: bigint, blocksPerYear: number): number {
  return (Number(supplyRatePerBlock) / Number(WAD)) * blocksPerYear * 10_000;
}

/**
 * Aave v3 currentLiquidityRate is the annualized APR in RAY (per-second
 * compounding semantics). At ~2% the APY/APR gap is ~2 bps, far inside the
 * 50 bps hysteresis, so APR is used as APY.
 */
export function aaveApyBps(currentLiquidityRate: bigint): number {
  return (Number(currentLiquidityRate) / Number(RAY)) * 10_000;
}

export function chooseFirstVenue(venusBps: number, aaveBps: number): 'venus' | 'aave' {
  return aaveBps > venusBps ? 'aave' : 'venus';
}

/** Venue as the chain sees it; a position in both venues resolves to the larger. */
export function detectVenue(venusUnderlyingWei: bigint, aaveATokenWei: bigint, dustWei: bigint): Venue {
  const inVenus = venusUnderlyingWei > dustWei;
  const inAave = aaveATokenWei > dustWei;
  if (inVenus && inAave) return venusUnderlyingWei >= aaveATokenWei ? 'venus' : 'aave';
  if (inVenus) return 'venus';
  if (inAave) return 'aave';
  return 'none';
}

export interface RotationInput {
  venue: 'venus' | 'aave';
  venusBps: number;
  aaveBps: number;
  betterStreak: number;
  hysteresisBps?: number;
  requiredStreak?: number;
}

export interface RotationDecision {
  action: 'hold' | 'rotate';
  target: 'venus' | 'aave';
  edgeBps: number;
  nextStreak: number;
}

/**
 * Rotate only when the other venue beats the current by more than the
 * hysteresis on this check AND on the previous one (streak of 2); the streak
 * resets the moment the edge falls back inside the hysteresis band.
 */
export function decideRotation(input: RotationInput): RotationDecision {
  const hysteresis = input.hysteresisBps ?? HYSTERESIS_BPS;
  const required = input.requiredStreak ?? REQUIRED_STREAK;
  const other: 'venus' | 'aave' = input.venue === 'venus' ? 'aave' : 'venus';
  const currentBps = input.venue === 'venus' ? input.venusBps : input.aaveBps;
  const otherBps = other === 'venus' ? input.venusBps : input.aaveBps;
  const edgeBps = otherBps - currentBps;

  if (edgeBps > hysteresis) {
    const nextStreak = input.betterStreak + 1;
    if (nextStreak >= required) {
      return { action: 'rotate', target: other, edgeBps, nextStreak: 0 };
    }
    return { action: 'hold', target: input.venue, edgeBps, nextStreak };
  }
  return { action: 'hold', target: input.venue, edgeBps, nextStreak: 0 };
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

export interface Rates {
  venusBps: number;
  aaveBps: number;
  blocksPerYear: number;
  venusRatePerBlock: string;
  aaveLiquidityRate: string;
}

export type Reader = Pick<PublicClient, 'getBlock' | 'readContract'>;

/** The Venus/Aave addresses for one managed token. Own-capital mode uses USDT. */
export interface Venues {
  token: `0x${string}`;
  vToken: `0x${string}`;
  aavePool: `0x${string}`;
}
const USDT_VENUES: Venues = { token: USDT.address, vToken: VENUS_VUSDT, aavePool: AAVE_POOL };

export async function readRates(client: Reader, venues: Venues = USDT_VENUES): Promise<Rates> {
  const latest = await client.getBlock();
  const span = 5000;
  const older = await client.getBlock({
    blockNumber: latest.number - BigInt(span),
  });
  const blocksPerYear = deriveBlocksPerYear(latest.timestamp, older.timestamp, span);

  const [venusRate, reserve] = await Promise.all([
    client.readContract({
      address: venues.vToken,
      abi: vTokenAbi,
      functionName: 'supplyRatePerBlock',
    }),
    client.readContract({
      address: venues.aavePool,
      abi: aavePoolAbi,
      functionName: 'getReserveData',
      args: [venues.token],
    }),
  ]);

  return {
    venusBps: venusApyBps(venusRate, blocksPerYear),
    aaveBps: aaveApyBps(reserve.currentLiquidityRate),
    blocksPerYear,
    venusRatePerBlock: venusRate.toString(),
    aaveLiquidityRate: reserve.currentLiquidityRate.toString(),
  };
}

export interface Position {
  walletUsdtWei: bigint;
  venusUnderlyingWei: bigint;
  aaveATokenWei: bigint;
  chainVenue: Venue;
}

export async function readPosition(
  client: Reader,
  self: `0x${string}`,
  venues: Venues = USDT_VENUES,
): Promise<Position> {
  const [walletUsdtWei, venusUnderlyingWei, reserve] = await Promise.all([
    client.readContract({
      address: venues.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [self],
    }),
    client.readContract({
      address: venues.vToken,
      abi: vTokenReadAbi,
      functionName: 'balanceOfUnderlying',
      args: [self],
    }),
    client.readContract({
      address: venues.aavePool,
      abi: aavePoolAbi,
      functionName: 'getReserveData',
      args: [venues.token],
    }),
  ]);
  const aaveATokenWei = await client.readContract({
    address: reserve.aTokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [self],
  });
  return {
    walletUsdtWei,
    venusUnderlyingWei,
    aaveATokenWei,
    chainVenue: detectVenue(venusUnderlyingWei, aaveATokenWei, DUST_WEI),
  };
}

// ---------------------------------------------------------------------------
// Chain writes
// ---------------------------------------------------------------------------

async function ensureAllowance(
  ctx: AgentContext,
  spender: `0x${string}`,
  amountWei: bigint,
): Promise<void> {
  const current = await ctx.publicClient.readContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.account.address, spender],
  });
  if (current >= amountWei) return;
  const hash = await ctx.walletClient.writeContract({
    address: USDT.address,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amountWei],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`approve reverted: ${hash}`);
  ctx.log({ event: 'approve', spender, amount: fromBaseUnits(amountWei, USDT.decimals), txHash: hash });
}

async function supplyVenus(ctx: AgentContext, amountWei: bigint): Promise<void> {
  await ensureAllowance(ctx, VENUS_VUSDT, amountWei);
  const { result, request } = await ctx.publicClient.simulateContract({
    address: VENUS_VUSDT,
    abi: vTokenAbi,
    functionName: 'mint',
    args: [amountWei],
    account: ctx.account,
  });
  if (result !== BigInt(0)) throw new Error(`venus mint would fail with code ${result}`);
  const hash = await ctx.walletClient.writeContract({ ...request, chain: ctx.walletClient.chain });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`venus mint reverted: ${hash}`);
  ctx.log({
    event: 'supply',
    venue: 'venus',
    amount: fromBaseUnits(amountWei, USDT.decimals),
    txHash: hash,
  });
}

export async function withdrawVenus(ctx: AgentContext): Promise<void> {
  // Redeeming the full vToken balance (not redeemUnderlying) exits exactly,
  // leaving no interest-accrual dust behind.
  const vTokenBalance = await ctx.publicClient.readContract({
    address: VENUS_VUSDT,
    abi: vTokenAbi,
    functionName: 'balanceOf',
    args: [ctx.account.address],
  });
  if (vTokenBalance === BigInt(0)) {
    ctx.log({ event: 'withdraw-skip', venue: 'venus', reason: 'no vToken balance' });
    return;
  }
  const { result, request } = await ctx.publicClient.simulateContract({
    address: VENUS_VUSDT,
    abi: vTokenAbi,
    functionName: 'redeem',
    args: [vTokenBalance],
    account: ctx.account,
  });
  if (result !== BigInt(0)) throw new Error(`venus redeem would fail with code ${result}`);
  const hash = await ctx.walletClient.writeContract({ ...request, chain: ctx.walletClient.chain });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`venus redeem reverted: ${hash}`);
  ctx.log({ event: 'withdraw', venue: 'venus', vTokens: vTokenBalance.toString(), txHash: hash });
}

async function supplyAave(ctx: AgentContext, amountWei: bigint): Promise<void> {
  await ensureAllowance(ctx, AAVE_POOL, amountWei);
  const hash = await ctx.walletClient.writeContract({
    address: AAVE_POOL,
    abi: aavePoolAbi,
    functionName: 'supply',
    args: [USDT.address, amountWei, ctx.account.address, 0],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`aave supply reverted: ${hash}`);
  ctx.log({
    event: 'supply',
    venue: 'aave',
    amount: fromBaseUnits(amountWei, USDT.decimals),
    txHash: hash,
  });
}

export async function withdrawAave(ctx: AgentContext): Promise<void> {
  // maxUint256 tells the pool to withdraw the full aToken balance including
  // interest accrued in the same block.
  const hash = await ctx.walletClient.writeContract({
    address: AAVE_POOL,
    abi: aavePoolAbi,
    functionName: 'withdraw',
    args: [USDT.address, maxUint256, ctx.account.address],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`aave withdraw reverted: ${hash}`);
  ctx.log({ event: 'withdraw', venue: 'aave', txHash: hash });
}

export async function supplyTo(ctx: AgentContext, venue: 'venus' | 'aave', amountWei: bigint): Promise<void> {
  if (venue === 'venus') await supplyVenus(ctx, amountWei);
  else await supplyAave(ctx, amountWei);
}

export function recordMove(ctx: AgentContext): void {
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const moves = ctx.state.get<number[]>('moves', []).filter((t) => t > dayAgo);
  ctx.state.set('moves', [...moves, now]);
}

export function movesToday(ctx: AgentContext): number {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  return ctx.state.get<number[]>('moves', []).filter((t) => t > dayAgo).length;
}

// ---------------------------------------------------------------------------
// Agent module
// ---------------------------------------------------------------------------

export const yieldAgent: AgentModule = {
  name: 'yield',
  category: 'yield',
  tickIntervalMs: 21_600_000,

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
      venusRatePerBlock: rates.venusRatePerBlock,
      aaveLiquidityRate: rates.aaveLiquidityRate,
      walletUsdt: fromBaseUnits(position.walletUsdtWei, USDT.decimals),
      venusUsdt: fromBaseUnits(position.venusUnderlyingWei, USDT.decimals),
      aaveUsdt: fromBaseUnits(position.aaveATokenWei, USDT.decimals),
    };

    if (venue === 'none') {
      const deployableWei = position.walletUsdtWei - RESERVE_WEI;
      if (deployableWei <= DUST_WEI) {
        ctx.log({ ...base, event: 'tick', decision: 'unfunded', deployable: fromBaseUnits(
          deployableWei > BigInt(0) ? deployableWei : BigInt(0),
          USDT.decimals,
        ) });
        return;
      }
      const target = chooseFirstVenue(rates.venusBps, rates.aaveBps);
      if (!ctx.breakers.allowAction('enter', 2)) {
        ctx.log({ ...base, event: 'tick', decision: 'enter-capped', target });
        return;
      }
      ctx.log({ ...base, event: 'tick', decision: 'enter', target, amount: fromBaseUnits(deployableWei, USDT.decimals) });
      await supplyTo(ctx, target, deployableWei);
      ctx.state.set('venue', target);
      ctx.state.set('betterStreak', 0);
      recordMove(ctx);
      return;
    }

    const decision = decideRotation({
      venue,
      venusBps: rates.venusBps,
      aaveBps: rates.aaveBps,
      betterStreak: ctx.state.get<number>('betterStreak', 0),
    });
    ctx.state.set('betterStreak', decision.nextStreak);

    if (decision.action === 'hold') {
      ctx.log({ ...base, event: 'tick', decision: 'hold', edgeBps: decision.edgeBps, betterStreak: decision.nextStreak });
      return;
    }

    if (!ctx.breakers.allowAction('rotate', 1)) {
      ctx.log({ ...base, event: 'tick', decision: 'rotate-capped', target: decision.target, edgeBps: decision.edgeBps });
      return;
    }

    ctx.log({ ...base, event: 'tick', decision: 'rotate', from: venue, to: decision.target, edgeBps: decision.edgeBps });
    if (venue === 'venus') await withdrawVenus(ctx);
    else await withdrawAave(ctx);
    ctx.state.set('venue', 'none');

    const walletAfterWei = await ctx.publicClient.readContract({
      address: USDT.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ctx.account.address],
    });
    const deployableWei = walletAfterWei - RESERVE_WEI;
    if (deployableWei <= DUST_WEI) {
      ctx.log({ event: 'rotate-abort', reason: 'nothing to redeploy after withdraw', wallet: fromBaseUnits(walletAfterWei, USDT.decimals) });
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
      venue === 'venus' ? position.venusUnderlyingWei
      : venue === 'aave' ? position.aaveATokenWei
      : BigInt(0);
    const edgeBps =
      venue === 'venus' ? rates.aaveBps - rates.venusBps
      : venue === 'aave' ? rates.venusBps - rates.aaveBps
      : Math.abs(rates.aaveBps - rates.venusBps);
    return {
      venue,
      positionUsdt: fromBaseUnits(positionWei, USDT.decimals),
      venusApyBps: rates.venusBps,
      aaveApyBps: rates.aaveBps,
      edgeBps,
      betterStreak: ctx.state.get<number>('betterStreak', 0),
      movesToday: movesToday(ctx),
      halted: ctx.breakers.isHalted().halted,
    };
  },
};

// ---------------------------------------------------------------------------
// Managed mode: run the SAME decision logic against a USER's account, moving
// their funds through the drain-proof YieldRouter instead of the agent's own
// wallet. Reads are account-scoped; the only write is one router selector.
// State/rate-limits are namespaced per managed account so many users share one
// agent process without cross-talk.
// ---------------------------------------------------------------------------

/**
 * How ONE managed agent decides to rotate a mandate. Everything else about the
 * managed path is shared (same reads, same router, same per-account state
 * namespacing), so this is the whole difference between two agents competing
 * for the same deposits.
 *
 * Defaulted to the incumbent's live behaviour, so `yield` is unchanged: same
 * gate, same 50 bps hysteresis, same two confirmations, same one rotation per
 * rolling day, and no minimum interval on top.
 */
export interface ManagedPolicy {
  decide(input: RotationInput): RotationDecision;
  /** Shortest gap between two rotations of one mandate. 0 disables the floor. */
  minRotationIntervalMs: number;
  /** Ceiling inside the breakers' rolling 24 hour window. */
  maxRotationsPerDay: number;
}

export const DEFAULT_MANAGED_POLICY: ManagedPolicy = {
  decide: decideRotation,
  minRotationIntervalMs: 0,
  maxRotationsPerDay: 1,
};

export async function managedYieldTick(
  ctx: AgentContext,
  executor: ManagedExecutor,
  policy: ManagedPolicy = DEFAULT_MANAGED_POLICY,
): Promise<void> {
  const acct = executor.account;
  // Namespace strategy state by (account, token) so a USDT mandate's hysteresis
  // and rate-limit state can never bleed into a USDC mandate on the same account.
  const ns = (k: string) => `managed:${acct.toLowerCase()}:${executor.deployment.symbol}:${k}`;

  const halted = ctx.breakers.isHalted();
  if (halted.halted) {
    ctx.log({ event: 'managed-skip', account: acct, reason: `halted: ${halted.reason}` });
    return;
  }

  const dep = executor.deployment;
  const venues: Venues = { token: dep.usdt, vToken: dep.vUsdt, aavePool: dep.aavePool };
  const rates = await readRates(ctx.publicClient, venues);
  const position = await readPosition(ctx.publicClient, acct, venues);
  const venue = position.chainVenue;

  const storedVenue = ctx.state.get<Venue>(ns('venue'), 'none');
  if (venue !== storedVenue) {
    ctx.log({ event: 'managed-venue-reconciled', account: acct, stored: storedVenue, chain: venue });
    ctx.state.set(ns('venue'), venue);
  }

  const base = {
    account: acct,
    token: dep.symbol,
    venue,
    venusApyBps: rates.venusBps,
    aaveApyBps: rates.aaveBps,
    walletUsdt: fromBaseUnits(position.walletUsdtWei, USDT.decimals),
    venusUsdt: fromBaseUnits(position.venusUnderlyingWei, USDT.decimals),
    aaveUsdt: fromBaseUnits(position.aaveATokenWei, USDT.decimals),
  };

  if (venue === 'none') {
    // Managed funds deploy in full: the router moves the account's entire USDT
    // balance, so there is no reserve/partial-deploy split as in own-capital mode.
    if (position.walletUsdtWei <= DUST_WEI) {
      ctx.log({ ...base, event: 'managed-tick', decision: 'unfunded' });
      return;
    }
    const target = chooseFirstVenue(rates.venusBps, rates.aaveBps);
    if (!ctx.breakers.allowAction(ns('enter'), 2)) {
      ctx.log({ ...base, event: 'managed-tick', decision: 'enter-capped', target });
      return;
    }
    const action = target === 'venus' ? 'toVenus' : 'toAave';
    const res = await executor.execute(action);
    ctx.state.set(ns('venue'), target);
    ctx.state.set(ns('betterStreak'), 0);
    ctx.log({ ...base, event: 'managed-tick', decision: 'enter', target, action, txHash: res.txHash, status: res.status });
    return;
  }

  const decision = policy.decide({
    venue,
    venusBps: rates.venusBps,
    aaveBps: rates.aaveBps,
    betterStreak: ctx.state.get<number>(ns('betterStreak'), 0),
  });
  ctx.state.set(ns('betterStreak'), decision.nextStreak);

  if (decision.action === 'hold') {
    ctx.log({ ...base, event: 'managed-tick', decision: 'hold', edgeBps: decision.edgeBps, betterStreak: decision.nextStreak });
    return;
  }
  // The floor is checked BEFORE the daily counter so a refused rotation costs
  // no slot, and it applies only here: an idle deposit is put to work on the
  // first tick regardless, since this bounds churn between venues, not entry.
  const now = Date.now();
  const sinceLastRotateMs = now - ctx.state.get<number>(ns('lastRotateAt'), 0);
  if (policy.minRotationIntervalMs > 0 && sinceLastRotateMs < policy.minRotationIntervalMs) {
    ctx.log({
      ...base,
      event: 'managed-tick',
      decision: 'rotate-cooldown',
      target: decision.target,
      edgeBps: decision.edgeBps,
      sinceLastRotateMs,
      minRotationIntervalMs: policy.minRotationIntervalMs,
    });
    return;
  }
  if (!ctx.breakers.allowAction(ns('rotate'), policy.maxRotationsPerDay)) {
    ctx.log({ ...base, event: 'managed-tick', decision: 'rotate-capped', target: decision.target, edgeBps: decision.edgeBps });
    return;
  }
  // One router call rotates: it unwinds the current venue and supplies the
  // target in a single tx, leaving the position token in the user's account.
  const action = decision.target === 'venus' ? 'toVenus' : 'toAave';
  // Anchored before the call, so a crash inside the execute window cannot let
  // the next tick fire a second rotation against a mandate already moving.
  ctx.state.set(ns('lastRotateAt'), now);
  const res = await executor.execute(action);
  ctx.state.set(ns('venue'), decision.target);
  ctx.log({ ...base, event: 'managed-tick', decision: 'rotate', from: venue, to: decision.target, action, edgeBps: decision.edgeBps, txHash: res.txHash, status: res.status });
}
