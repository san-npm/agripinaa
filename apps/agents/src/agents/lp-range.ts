import { executeOphisSwap } from '@ophis/agent-swap';
import { erc20Abi, parseAbi, parseEventLogs, zeroAddress, type Log } from 'viem';

import { TOKENS_BSC, fromBaseUnits, toBaseUnits } from '@agripinaa/shared';

import { ChassisOphisWallet } from '../ophis-wallet';
import type { AgentContext, AgentModule } from '../types';

/* ------------------------------------------------------------------ */
/* Pure decision logic (exported for tests, no I/O)                    */
/* ------------------------------------------------------------------ */

export const RANGE_PCT = 0.05;
export const OUT_OF_RANGE_EXIT_MS = 30 * 60 * 1000;
export const DAY_MS = 24 * 3600 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const MAX_REBALANCES_PER_WEEK = 4;
export const MIN_SWAP_NOTIONAL_USD = 1;
/* Below this per-leg value the pool mint computes zero liquidity and reverts. */
export const MIN_MINT_LEG_USD = 0.05;

/** ln(1 + pct) / ln(1.0001), floored: 5% -> 487 ticks. */
export function pctToTickDelta(pct: number): number {
  return Math.floor(Math.log(1 + pct) / Math.log(1.0001));
}

/** Lower bound snaps down, upper snaps up, so the current tick stays strictly inside. */
export function snapRange(
  currentTick: number,
  tickDelta: number,
  tickSpacing: number,
): { tickLower: number; tickUpper: number } {
  const tickLower = Math.floor((currentTick - tickDelta) / tickSpacing) * tickSpacing;
  const tickUpper = Math.ceil((currentTick + tickDelta) / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

/** Uniswap-style position activity: lower inclusive, upper exclusive. */
export function isInRange(currentTick: number, tickLower: number, tickUpper: number): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

/** Out-of-range timer: starts on first out-of-range tick, resets on re-entry. */
export function nextOutSince(
  inRange: boolean,
  prevOutSince: number | null,
  now: number,
): number | null {
  if (inRange) return null;
  return prevOutSince ?? now;
}

export function shouldRebalance(
  outSince: number | null,
  now: number,
  thresholdMs: number = OUT_OF_RANGE_EXIT_MS,
): boolean {
  return outSince !== null && now - outSince > thresholdMs;
}

/**
 * A stored position whose on-chain liquidity has fallen to zero is the residue
 * of an interrupted rebalance (liquidity removed, re-mint never completed), not
 * a healthy position. The NFT still exists and still reports its old ticks, so a
 * range-check against it happily answers "in range" forever while the capital
 * sits idle in the wallet. Treat zero liquidity as "no position" so the normal
 * recover-then-mint path takes over.
 */
export function needsReentry(liquidity: bigint): boolean {
  return liquidity <= BigInt(0);
}

export interface RebalanceLeg {
  sell: 'WBNB' | 'USDT';
  amountUnits: number;
  notionalUsd: number;
}

/**
 * One swap that moves inventory to ~50/50 by value: sell half the value gap
 * from the heavy side. Returns null when the gap leg is <= minNotionalUsd.
 */
export function computeRebalanceLeg(
  wbnbUnits: number,
  usdtUnits: number,
  usdtPerWbnb: number,
  minNotionalUsd: number = MIN_SWAP_NOTIONAL_USD,
): RebalanceLeg | null {
  const excessUsd = (wbnbUnits * usdtPerWbnb - usdtUnits) / 2;
  if (!Number.isFinite(excessUsd) || Math.abs(excessUsd) <= minNotionalUsd) return null;
  if (excessUsd > 0) {
    return { sell: 'WBNB', amountUnits: excessUsd / usdtPerWbnb, notionalUsd: excessUsd };
  }
  return { sell: 'USDT', amountUnits: -excessUsd, notionalUsd: -excessUsd };
}

export function pruneWindow(timestamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

/** Both pool tokens are 18 decimals, so the raw ratio needs no decimal scaling. */
export function sqrtPriceX96ToUsdtPerWbnb(sqrtPriceX96: bigint, wbnbIsToken0: boolean): number {
  const token1PerToken0 = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return wbnbIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

export function formatWholeUnits(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`cannot format non-positive amount: ${amount}`);
  }
  return amount
    .toFixed(12)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/* ------------------------------------------------------------------ */
/* Verified protocol addresses                                         */
/* ------------------------------------------------------------------ */

/*
 * Probed 2026-08-18 with tsx + viem readContract on https://bsc-rpc.publicnode.com:
 *   NPM.factory() -> 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865 (matches expected factory)
 *   NPM.WETH9()  -> 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c (WBNB, matches TOKENS_BSC)
 */
const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as const;
const EXPECTED_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';

/*
 * Pool probes, same date and RPC, factory.getPool(WBNB, USDT, fee):
 *   fee 500  -> 0x36696169C63e42cd08ce11f5deeBbCeBae652050 liquidity 1.19e24 tickSpacing 10
 *   fee 100  -> 0x172fcD41E0913e95784454622d1c3724f546f849 liquidity 8.96e24 tickSpacing 1
 *   fee 2500 -> 0x1401ff943D08a7E098328C1d3a9d388923B115D2 liquidity 2.00e22 tickSpacing 50
 * All three report token0 = USDT, token1 = WBNB. The pool is still resolved at
 * runtime through the verified factory rather than hardcoded.
 */
const POOL_FEE_TIERS = [500, 100, 2500] as const;

const WBNB = TOKENS_BSC['WBNB']!;
const USDT = TOKENS_BSC['USDT']!;

/* ------------------------------------------------------------------ */
/* ABIs and runtime constants                                          */
/* ------------------------------------------------------------------ */

const NPM_ABI = parseAbi([
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

/* PancakeSwap V3 slot0 layout: feeProtocol is uint32 (uint8 on Uniswap V3). */
const POOL_ABI = parseAbi([
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)',
]);

/** Coarse min-out floor on mint/exit (concentrated-liquidity consumed
 * amounts vary with the tick, so this is a backstop; a legitimate revert
 * just defers the action). The primary sandwich defense is the TWAP gate. */
const LP_MIN_BPS = BigInt(9000); // accept >= 90% of desired per token
const TWAP_WINDOW_SECONDS = 60;
const TWAP_MAX_TICK_DEVIATION = 100; // ~1% price; a sandwich must exceed this

/**
 * Reject action when the pool's spot tick has been pushed away from its
 * short TWAP (the signature of a sandwich). Best-effort: if the pool lacks
 * observation history (observe reverts), returns true so the coarse mins
 * remain the only guard rather than halting the strategy.
 */
async function twapAligned(ctx: AgentContext, pool: `0x${string}`, spotTick: number): Promise<boolean> {
  try {
    const [tickCumulatives] = await ctx.publicClient.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'observe',
      args: [[TWAP_WINDOW_SECONDS, 0]],
    });
    const delta = Number(tickCumulatives[1]! - tickCumulatives[0]!);
    const twapTick = Math.trunc(delta / TWAP_WINDOW_SECONDS);
    const deviation = Math.abs(spotTick - twapTick);
    if (deviation > TWAP_MAX_TICK_DEVIATION) {
      ctx.log({ event: 'twap-guard-skip', spotTick, twapTick, deviation });
      return false;
    }
    return true;
  } catch {
    ctx.log({ event: 'twap-unavailable', pool });
    return true;
  }
}

const MAX_UINT128 = BigInt('0xffffffffffffffffffffffffffffffff');
const USDT_DUST_RESERVE = toBaseUnits('0.1', USDT.decimals);
const WBNB_DUST_RESERVE = toBaseUnits('0.0002', WBNB.decimals);
const PENDING_ORDER_MAX_AGE_MS = 35 * 60 * 1000;
const FILL_POLL_ATTEMPTS = 10;
const FILL_POLL_INTERVAL_MS = 15_000;
const TX_DEADLINE_SECONDS = 600;

interface PositionState {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  outSince: number | null;
}

interface PoolInfo {
  pool: `0x${string}`;
  fee: number;
  tickSpacing: number;
  wbnbIsToken0: boolean;
}

interface PendingOrder {
  orderUid: string;
  sellSymbol: 'WBNB' | 'USDT';
  sellAmountWei: string;
  preSellBalanceWei: string;
  placedAt: number;
}

/* ------------------------------------------------------------------ */
/* Chain helpers                                                       */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function txDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + TX_DEADLINE_SECONDS);
}

async function erc20Balance(ctx: AgentContext, token: `0x${string}`): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ctx.account.address],
  });
}

async function readSlot0(
  ctx: AgentContext,
  pool: `0x${string}`,
): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const slot0 = await ctx.publicClient.readContract({
    address: pool,
    abi: POOL_ABI,
    functionName: 'slot0',
  });
  return { sqrtPriceX96: slot0[0], tick: slot0[1] };
}

async function resolvePool(ctx: AgentContext): Promise<PoolInfo> {
  const cached = ctx.state.get<PoolInfo | null>('poolInfo', null);
  if (cached && cached.pool) return cached;

  const factory = await ctx.publicClient.readContract({
    address: POSITION_MANAGER,
    abi: NPM_ABI,
    functionName: 'factory',
  });
  if (factory.toLowerCase() !== EXPECTED_FACTORY.toLowerCase()) {
    /* Minting through a manager wired to an unknown factory risks the funds. */
    ctx.breakers.halt(`position manager factory mismatch: ${factory}`);
    throw new Error(`position manager factory mismatch: ${factory}`);
  }

  // Select the DEEPEST pool across fee tiers, not the first with any
  // liquidity: a shallow reference pool makes the price cheaper to skew
  // (the mint/exit slippage protection below rides on this pool's tick).
  let best: { info: PoolInfo; liquidity: bigint } | null = null;
  for (const fee of POOL_FEE_TIERS) {
    const pool = await ctx.publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [WBNB.address, USDT.address, fee],
    });
    if (pool === zeroAddress) {
      ctx.log({ event: 'pool-probe', fee, result: 'no-pool' });
      continue;
    }
    const liquidity = await ctx.publicClient.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'liquidity',
    });
    if (liquidity <= BigInt(0)) {
      ctx.log({ event: 'pool-probe', fee, pool, result: 'zero-liquidity' });
      continue;
    }
    const [tickSpacing, token0] = await Promise.all([
      ctx.publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: 'tickSpacing' }),
      ctx.publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }),
    ]);
    const info: PoolInfo = {
      pool,
      fee,
      tickSpacing,
      wbnbIsToken0: token0.toLowerCase() === WBNB.address.toLowerCase(),
    };
    if (!best || liquidity > best.liquidity) best = { info, liquidity };
  }
  if (best) {
    ctx.state.set('poolInfo', best.info);
    ctx.log({ event: 'pool-selected', ...best.info, liquidity: best.liquidity.toString() });
    return best.info;
  }
  throw new Error('no WBNB/USDT PancakeSwap V3 pool with liquidity found');
}

type PendingStatus = 'none' | 'pending' | 'filled' | 'expired';

async function checkPendingOrder(ctx: AgentContext): Promise<PendingStatus> {
  const po = ctx.state.get<PendingOrder | null>('pendingOrder', null);
  if (!po) return 'none';
  const token = po.sellSymbol === 'WBNB' ? WBNB : USDT;
  const balance = await erc20Balance(ctx, token.address);
  const pre = BigInt(po.preSellBalanceWei);
  const amount = BigInt(po.sellAmountWei);
  /* Filled when >= 90% of the sell amount left the wallet (fee dust tolerance). */
  const filledThreshold = pre - (amount * BigInt(9)) / BigInt(10);
  if (balance <= filledThreshold) {
    ctx.state.set('pendingOrder', null);
    ctx.log({ event: 'ophis-order-filled', orderUid: po.orderUid });
    return 'filled';
  }
  if (Date.now() - po.placedAt > PENDING_ORDER_MAX_AGE_MS) {
    ctx.state.set('pendingOrder', null);
    ctx.log({ event: 'ophis-order-stale-cleared', orderUid: po.orderUid });
    return 'expired';
  }
  return 'pending';
}

async function findMintedTokenId(ctx: AgentContext, logs: Log[]): Promise<bigint> {
  const events = parseEventLogs({ abi: NPM_ABI, logs, eventName: 'IncreaseLiquidity' }).filter(
    (l) => l.address.toLowerCase() === POSITION_MANAGER.toLowerCase(),
  );
  const first = events[0];
  if (first) return first.args.tokenId;
  ctx.log({ event: 'mint-event-parse-miss', fallback: 'tokenOfOwnerByIndex' });
  const balance = await ctx.publicClient.readContract({
    address: POSITION_MANAGER,
    abi: NPM_ABI,
    functionName: 'balanceOf',
    args: [ctx.account.address],
  });
  if (balance <= BigInt(0)) throw new Error('mint receipt has no IncreaseLiquidity and owner holds no NPM tokens');
  return ctx.publicClient.readContract({
    address: POSITION_MANAGER,
    abi: NPM_ABI,
    functionName: 'tokenOfOwnerByIndex',
    args: [ctx.account.address, balance - BigInt(1)],
  });
}

/**
 * Adopt an existing on-chain position for this pair when state has none
 * (e.g. after a host migration wiped local state). Scans the wallet's NPM
 * tokens, newest first, and returns the first with live liquidity whose
 * token pair and fee match the reference pool.
 */
async function recoverPosition(ctx: AgentContext, info: PoolInfo): Promise<PositionState | null> {
  const balance = await ctx.publicClient.readContract({
    address: POSITION_MANAGER,
    abi: NPM_ABI,
    functionName: 'balanceOf',
    args: [ctx.account.address],
  });
  const pair = new Set([WBNB.address.toLowerCase(), USDT.address.toLowerCase()]);
  for (let i = balance - BigInt(1); i >= BigInt(0); i -= BigInt(1)) {
    const tokenId = await ctx.publicClient.readContract({
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'tokenOfOwnerByIndex',
      args: [ctx.account.address, i],
    });
    const p = await ctx.publicClient.readContract({
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'positions',
      args: [tokenId],
    });
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = p;
    // Match on the token PAIR, not the fee tier: a live position from before
    // a reference-pool change must still be managed (in its own pool) rather
    // than abandoned. Repoint poolInfo to the position's pool so range-check
    // and exit use the right tick; new mints still pick the deepest pool.
    if (liquidity > BigInt(0) && pair.has(token0.toLowerCase()) && pair.has(token1.toLowerCase())) {
      if (fee !== info.fee) {
        const pool = await ctx.publicClient.readContract({
          address: EXPECTED_FACTORY,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [token0, token1, fee],
        });
        const tickSpacing = await ctx.publicClient.readContract({
          address: pool,
          abi: POOL_ABI,
          functionName: 'tickSpacing',
        });
        ctx.state.set('poolInfo', {
          pool,
          fee,
          tickSpacing,
          wbnbIsToken0: token0.toLowerCase() === WBNB.address.toLowerCase(),
        } satisfies PoolInfo);
      }
      ctx.log({ event: 'position-recovered', tokenId: tokenId.toString(), fee, tickLower, tickUpper });
      return { tokenId: tokenId.toString(), tickLower, tickUpper, outSince: null };
    }
    if (i === BigInt(0)) break;
  }
  return null;
}

async function tryMint(ctx: AgentContext, info: PoolInfo): Promise<void> {
  const pending = await checkPendingOrder(ctx);
  if (pending === 'pending') {
    ctx.log({ event: 'mint-deferred', reason: 'ophis-order-pending' });
    return;
  }

  const [wbnbBal, usdtBal, slot0] = await Promise.all([
    erc20Balance(ctx, WBNB.address),
    erc20Balance(ctx, USDT.address),
    readSlot0(ctx, info.pool),
  ]);
  const availWbnb = wbnbBal > WBNB_DUST_RESERVE ? wbnbBal - WBNB_DUST_RESERVE : BigInt(0);
  const availUsdt = usdtBal > USDT_DUST_RESERVE ? usdtBal - USDT_DUST_RESERVE : BigInt(0);
  const price = sqrtPriceX96ToUsdtPerWbnb(slot0.sqrtPriceX96, info.wbnbIsToken0);
  const wbnbUnits = Number(fromBaseUnits(availWbnb, WBNB.decimals));
  const usdtUnits = Number(fromBaseUnits(availUsdt, USDT.decimals));

  if (wbnbUnits * price < MIN_MINT_LEG_USD || usdtUnits < MIN_MINT_LEG_USD) {
    ctx.log({
      event: 'mint-skipped',
      reason: 'insufficient-leg',
      wbnbUnits,
      usdtUnits,
      usdtPerWbnb: price,
    });
    return;
  }
  // Defeat the sandwich: refuse to mint while spot price is skewed from TWAP.
  if (!(await twapAligned(ctx, info.pool, slot0.tick))) {
    ctx.log({ event: 'mint-skipped', reason: 'twap-deviation' });
    return;
  }
  if (!ctx.breakers.allowAction('mint', 3)) {
    ctx.log({ event: 'mint-skipped', reason: 'daily-mint-cap' });
    return;
  }

  const { tickLower, tickUpper } = snapRange(slot0.tick, pctToTickDelta(RANGE_PCT), info.tickSpacing);
  const wallet = new ChassisOphisWallet(ctx.account, ctx.publicClient, ctx.walletClient);
  try {
    await wallet.ensureErc20Allowance(USDT.address, POSITION_MANAGER, availUsdt);
    await wallet.ensureErc20Allowance(WBNB.address, POSITION_MANAGER, availWbnb);

    const amount0Desired = info.wbnbIsToken0 ? availWbnb : availUsdt;
    const amount1Desired = info.wbnbIsToken0 ? availUsdt : availWbnb;
    const token0 = info.wbnbIsToken0 ? WBNB.address : USDT.address;
    const token1 = info.wbnbIsToken0 ? USDT.address : WBNB.address;

    const hash = await ctx.walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'mint',
      args: [
        {
          token0,
          token1,
          fee: info.fee,
          tickLower,
          tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min: (amount0Desired * LP_MIN_BPS) / BigInt(10000),
          amount1Min: (amount1Desired * LP_MIN_BPS) / BigInt(10000),
          recipient: ctx.account.address,
          deadline: txDeadline(),
        },
      ],
      account: ctx.account,
      chain: ctx.walletClient.chain,
    });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      ctx.log({ event: 'mint-reverted', txHash: hash });
      return;
    }
    const tokenId = await findMintedTokenId(ctx, receipt.logs);
    const position: PositionState = {
      tokenId: tokenId.toString(),
      tickLower,
      tickUpper,
      outSince: null,
    };
    ctx.state.set('position', position);
    ctx.log({
      event: 'minted',
      txHash: hash,
      tokenId: position.tokenId,
      tickLower,
      tickUpper,
      currentTick: slot0.tick,
      wbnbUnits,
      usdtUnits,
    });
  } catch (err) {
    ctx.log({ event: 'mint-failed', error: String(err) });
  }
}

async function exitPosition(ctx: AgentContext, pos: PositionState, info: PoolInfo): Promise<boolean> {
  const tokenId = BigInt(pos.tokenId);
  try {
    // Removing liquidity at a manipulated price lets an attacker skew the
    // returned token ratio; defer the exit while spot diverges from TWAP.
    // Deferring is safe: an out-of-range position idles, it does not bleed.
    const slot0 = await readSlot0(ctx, info.pool);
    if (!(await twapAligned(ctx, info.pool, slot0.tick))) {
      ctx.log({ event: 'exit-deferred', reason: 'twap-deviation', tokenId: pos.tokenId });
      return false;
    }
    const position = await ctx.publicClient.readContract({
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'positions',
      args: [tokenId],
    });
    const liquidity = position[7];
    if (liquidity > BigInt(0)) {
      const decreaseHash = await ctx.walletClient.writeContract({
        address: POSITION_MANAGER,
        abi: NPM_ABI,
        functionName: 'decreaseLiquidity',
        args: [
          {
            tokenId,
            liquidity,
            amount0Min: BigInt(0),
            amount1Min: BigInt(0),
            deadline: txDeadline(),
          },
        ],
        account: ctx.account,
        chain: ctx.walletClient.chain,
      });
      const decreaseReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: decreaseHash });
      if (decreaseReceipt.status !== 'success') {
        ctx.log({ event: 'decrease-liquidity-reverted', txHash: decreaseHash, tokenId: pos.tokenId });
        return false;
      }
      ctx.log({ event: 'decrease-liquidity', txHash: decreaseHash, tokenId: pos.tokenId });
    }
    const collectHash = await ctx.walletClient.writeContract({
      address: POSITION_MANAGER,
      abi: NPM_ABI,
      functionName: 'collect',
      args: [
        {
          tokenId,
          recipient: ctx.account.address,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
      account: ctx.account,
      chain: ctx.walletClient.chain,
    });
    const collectReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: collectHash });
    if (collectReceipt.status !== 'success') {
      ctx.log({ event: 'collect-reverted', txHash: collectHash, tokenId: pos.tokenId });
      return false;
    }
    ctx.log({ event: 'collected', txHash: collectHash, tokenId: pos.tokenId });
    return true;
  } catch (err) {
    ctx.log({ event: 'exit-failed', tokenId: pos.tokenId, error: String(err) });
    return false;
  }
}

async function rebalanceInventory(ctx: AgentContext, info: PoolInfo): Promise<void> {
  const [wbnbBal, usdtBal, slot0] = await Promise.all([
    erc20Balance(ctx, WBNB.address),
    erc20Balance(ctx, USDT.address),
    readSlot0(ctx, info.pool),
  ]);
  const price = sqrtPriceX96ToUsdtPerWbnb(slot0.sqrtPriceX96, info.wbnbIsToken0);
  const leg = computeRebalanceLeg(
    Number(fromBaseUnits(wbnbBal, WBNB.decimals)),
    Number(fromBaseUnits(usdtBal, USDT.decimals)),
    price,
  );
  if (!leg) {
    ctx.log({ event: 'rebalance-swap-skipped', reason: 'imbalance-under-min-notional' });
    return;
  }
  const sellToken = leg.sell === 'WBNB' ? WBNB : USDT;
  const buyToken = leg.sell === 'WBNB' ? USDT : WBNB;
  const sellAmount = formatWholeUnits(leg.amountUnits);
  const preSellBalance = leg.sell === 'WBNB' ? wbnbBal : usdtBal;

  const wallet = new ChassisOphisWallet(ctx.account, ctx.publicClient, ctx.walletClient);
  const result = await executeOphisSwap(
    wallet,
    {
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount,
      slippageBps: 100,
    },
    {},
  );
  const pendingOrder: PendingOrder = {
    orderUid: result.orderUid,
    sellSymbol: leg.sell,
    sellAmountWei: toBaseUnits(sellAmount, sellToken.decimals).toString(),
    preSellBalanceWei: preSellBalance.toString(),
    placedAt: Date.now(),
  };
  ctx.state.set('pendingOrder', pendingOrder);
  ctx.log({
    event: 'ophis-swap-submitted',
    orderUid: result.orderUid,
    explorerUrl: result.explorerUrl,
    sellToken: sellToken.symbol,
    buyToken: buyToken.symbol,
    sellAmount,
    notionalUsd: leg.notionalUsd,
    minBuyAmount: result.minBuyAmount,
    enrollmentWarning: result.enrollmentWarning ?? null,
  });

  for (let i = 0; i < FILL_POLL_ATTEMPTS; i += 1) {
    await sleep(FILL_POLL_INTERVAL_MS);
    const status = await checkPendingOrder(ctx);
    if (status !== 'pending') return;
  }
  ctx.log({ event: 'ophis-fill-poll-timeout', orderUid: result.orderUid });
}

/* ------------------------------------------------------------------ */
/* Agent module                                                        */
/* ------------------------------------------------------------------ */

export const lpRangeAgent: AgentModule = {
  name: 'lp-range',
  category: 'rebalancing',
  tickIntervalMs: 600_000,

  async tick(ctx) {
    if (ctx.breakers.isHalted().halted) {
      ctx.log({ event: 'tick-skipped', reason: 'halted' });
      return;
    }
    let info = await resolvePool(ctx);
    let pos = ctx.state.get<PositionState | null>('position', null);

    // Self-heal the other direction: state may point at a tokenId that has
    // already been drained (a rebalance removed the liquidity and the re-mint
    // never landed). Revalidate against the chain before trusting the stored
    // ticks, otherwise the range-check below reports a healthy in-range
    // position forever and the capital never gets redeployed.
    if (pos) {
      const onChain = await ctx.publicClient.readContract({
        address: POSITION_MANAGER,
        abi: NPM_ABI,
        functionName: 'positions',
        args: [BigInt(pos.tokenId)],
      });
      if (needsReentry(onChain[7])) {
        ctx.log({ event: 'position-empty', tokenId: pos.tokenId });
        ctx.state.set('position', null);
        pos = null;
      }
    }

    // Self-heal (like the other agents read their position from chain): if
    // state has no position but the wallet already owns a live one for this
    // pair, adopt it rather than minting a duplicate and stranding the old.
    if (!pos) {
      pos = await recoverPosition(ctx, info);
      if (pos) {
        ctx.state.set('position', pos);
        info = await resolvePool(ctx); // recovery may have repointed the pool
      }
    }

    if (!pos) {
      await tryMint(ctx, info);
      return;
    }

    const now = Date.now();
    const slot0 = await readSlot0(ctx, info.pool);
    const inRange = isInRange(slot0.tick, pos.tickLower, pos.tickUpper);
    const outSince = nextOutSince(inRange, pos.outSince, now);
    if (outSince !== pos.outSince) {
      ctx.state.set('position', { ...pos, outSince });
    }
    ctx.log({
      event: 'range-check',
      tokenId: pos.tokenId,
      currentTick: slot0.tick,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      inRange,
      outSinceMs: outSince === null ? null : now - outSince,
    });

    if (!shouldRebalance(outSince, now)) return;

    const weekly = pruneWindow(ctx.state.get<number[]>('rebalanceTimes', []), now, WEEK_MS);
    if (weekly.length >= MAX_REBALANCES_PER_WEEK) {
      ctx.log({ event: 'rebalance-skipped', reason: 'weekly-cap', rebalancesThisWeek: weekly.length });
      ctx.state.set('rebalanceTimes', weekly);
      return;
    }
    if (!ctx.breakers.allowAction('rebalance', 2)) {
      ctx.log({ event: 'rebalance-skipped', reason: 'daily-cap' });
      return;
    }

    /* Committed: count it even if a later step fails, so caps stay conservative. */
    ctx.state.set('rebalanceTimes', [...weekly, now]);
    ctx.log({ event: 'rebalance-start', tokenId: pos.tokenId, currentTick: slot0.tick });

    const exited = await exitPosition(ctx, pos, info);
    if (!exited) return;
    ctx.state.set('position', null);

    try {
      await rebalanceInventory(ctx, info);
    } catch (err) {
      ctx.log({ event: 'rebalance-swap-failed', error: String(err) });
    }
    /* Re-mint defers to the next tick when the Ophis order has not filled yet. */
    await tryMint(ctx, info);
  },

  async status(ctx) {
    const now = Date.now();
    const pos = ctx.state.get<PositionState | null>('position', null);
    const weekly = pruneWindow(ctx.state.get<number[]>('rebalanceTimes', []), now, WEEK_MS);
    let currentTick: number | null = null;
    try {
      const info = await resolvePool(ctx);
      currentTick = (await readSlot0(ctx, info.pool)).tick;
    } catch {
      currentTick = null;
    }
    const halted = ctx.breakers.isHalted();
    return {
      tokenId: pos?.tokenId ?? null,
      tickLower: pos?.tickLower ?? null,
      tickUpper: pos?.tickUpper ?? null,
      currentTick,
      inRange:
        pos && currentTick !== null ? isInRange(currentTick, pos.tickLower, pos.tickUpper) : null,
      outSinceMinutes:
        pos?.outSince != null ? Math.round((now - pos.outSince) / 60000) : null,
      rebalancesToday: pruneWindow(weekly, now, DAY_MS).length,
      rebalancesThisWeek: weekly.length,
      halted: halted.halted,
    };
  },
};
