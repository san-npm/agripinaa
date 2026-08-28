'use client';

import { PANCAKE_V3_FACTORY_BSC } from '@agripinaa/shared/funding';
import {
  managedStrategyFor,
  PANCAKE_V3_POSITION_MANAGER,
  type ManagedStrategySlug,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import {
  erc20Abi,
  formatUnits,
  parseAbi,
  zeroAddress,
  type Hex,
} from 'viem';

import { createBscPublicClient } from './bsc-public-client';

const NPM_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
]);

export interface StrategyAssetBalance {
  symbol: string;
  decimals: number;
  wei: bigint;
  formatted: string;
}

export type RangerRangeState = 'in-range' | 'out-of-range' | 'unknown';

export interface RangerPosition {
  tokenId: bigint;
  fee: number;
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number | null;
  rangeState: RangerRangeState;
  liquidity: bigint;
  estimated0: number;
  estimated1: number;
  owed0: bigint;
  owed1: bigint;
}

export interface StrategyAccountPosition {
  assets: StrategyAssetBalance[];
  nativeBnbWei: bigint;
  nativeBnb: string;
  ranger: RangerPosition | null;
}

export type StrategyPositionViewState = 'loading' | 'position' | 'error';

/** A failed refresh must hide last-known balances instead of presenting them as live. */
export function strategyPositionViewState(
  hasPosition: boolean,
  loadError: boolean,
): StrategyPositionViewState {
  if (loadError) return 'error';
  return hasPosition ? 'position' : 'loading';
}

export type RangerEmptyState = 'preparing' | 'recorded-unavailable' | 'inactive';

/** Never describe Ranger as working unless both its runner and key are live. */
export function rangerEmptyState(
  runner: string,
  validity: string,
  positionTokenId: string | null,
): RangerEmptyState {
  if (positionTokenId) return 'recorded-unavailable';
  return runner === 'ready' && validity === 'valid' ? 'preparing' : 'inactive';
}

/** A stale/burned NFT reference must not make already-readable wallet balances fail. */
export async function readRangerOwnerOrNull(
  readOwner: () => Promise<string>,
): Promise<string | null> {
  try {
    return await readOwner();
  } catch {
    return null;
  }
}

export function strategyAccountReadProblem(account: string): string | null {
  if (account === 'unknown') return 'This saved session has no account address, so its live position cannot be read.';
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return 'This saved session contains an invalid account address.';
  return null;
}

export function rangerRangeState(
  currentTick: number | null,
  tickLower: number,
  tickUpper: number,
): RangerRangeState {
  if (currentTick == null) return 'unknown';
  return currentTick >= tickLower && currentTick < tickUpper ? 'in-range' : 'out-of-range';
}

/** Approximate the two assets represented by V3 liquidity at the current tick. */
export function estimateV3Amounts(
  liquidity: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
): readonly [number, number] {
  const l = Number(liquidity);
  const sqrt = (tick: number) => Math.pow(1.0001, tick / 2);
  const lower = sqrt(tickLower);
  const upper = sqrt(tickUpper);
  const current = sqrt(currentTick);
  let amount0 = 0;
  let amount1 = 0;
  if (current <= lower) {
    amount0 = l * (upper - lower) / (lower * upper);
  } else if (current < upper) {
    amount0 = l * (upper - current) / (current * upper);
    amount1 = l * (current - lower);
  } else {
    amount1 = l * (upper - lower);
  }
  return [amount0 / (10 ** decimals0), amount1 / (10 ** decimals1)] as const;
}

function symbolForAddress(address: string): string {
  return Object.values(TOKENS_BSC).find(
    (token) => token.address.toLowerCase() === address.toLowerCase(),
  )?.symbol ?? 'TOKEN';
}

function decimalsForAddress(address: string): number {
  return Object.values(TOKENS_BSC).find(
    (token) => token.address.toLowerCase() === address.toLowerCase(),
  )?.decimals ?? 18;
}

async function readRangerPosition(
  client: ReturnType<typeof createBscPublicClient>,
  account: Hex,
  tokenIdText: string | null,
): Promise<RangerPosition | null> {
  if (!tokenIdText || !/^[1-9]\d*$/.test(tokenIdText)) return null;
  const tokenId = BigInt(tokenIdText);
  const owner = await readRangerOwnerOrNull(() => client.readContract({
    address: PANCAKE_V3_POSITION_MANAGER,
    abi: NPM_ABI,
    functionName: 'ownerOf',
    args: [tokenId],
  }));
  if (!owner) return null;
  if (owner.toLowerCase() !== account.toLowerCase()) return null;
  const wbnb = TOKENS_BSC.WBNB!.address.toLowerCase();
  const usdt = TOKENS_BSC.USDT!.address.toLowerCase();
  const position = await client.readContract({
    address: PANCAKE_V3_POSITION_MANAGER,
    abi: NPM_ABI,
    functionName: 'positions',
    args: [tokenId],
  });
  const token0 = position[2];
  const token1 = position[3];
  const pair = new Set([token0.toLowerCase(), token1.toLowerCase()]);
  const liquidity = position[7];
  const owed0 = position[10];
  const owed1 = position[11];
  if (!pair.has(wbnb) || !pair.has(usdt) || (liquidity === 0n && owed0 === 0n && owed1 === 0n)) {
    return null;
  }

  const fee = position[4];
  const tickLower = position[5];
  const tickUpper = position[6];
  const pool = await client.readContract({
    address: PANCAKE_V3_FACTORY_BSC,
    abi: FACTORY_ABI,
    functionName: 'getPool',
    args: [token0, token1, fee],
  });
  let currentTick: number | null = null;
  if (pool !== zeroAddress) {
    const slot0 = await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' });
    currentTick = slot0[1];
  }
  const [estimated0, estimated1] = currentTick == null
    ? [0, 0]
    : estimateV3Amounts(
        liquidity,
        currentTick,
        tickLower,
        tickUpper,
        decimalsForAddress(token0),
        decimalsForAddress(token1),
      );
  return {
    tokenId,
    fee,
    token0: symbolForAddress(token0),
    token1: symbolForAddress(token1),
    tickLower,
    tickUpper,
    currentTick,
    rangeState: rangerRangeState(currentTick, tickLower, tickUpper),
    liquidity,
    estimated0,
    estimated1,
    owed0,
    owed1,
  };
}

/** Latest on-chain inventory; no historical/archive RPC call is used. */
export async function readStrategyAccountPosition(
  slug: ManagedStrategySlug,
  account: Hex,
  rangerTokenId: string | null = null,
): Promise<StrategyAccountPosition> {
  const strategy = managedStrategyFor(slug);
  if (!strategy) throw new Error(`unknown managed strategy ${slug}`);
  const client = createBscPublicClient();
  const [nativeBnbWei, ...assetWei] = await Promise.all([
    client.getBalance({ address: account }),
    ...strategy.depositTokens.map((symbol) => {
      const token = TOKENS_BSC[symbol]!;
      return client.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      });
    }),
  ]);
  const assets = strategy.depositTokens.map((symbol, index) => {
    const token = TOKENS_BSC[symbol]!;
    const wei = assetWei[index]!;
    return { symbol, decimals: token.decimals, wei, formatted: formatUnits(wei, token.decimals) };
  });
  let ranger: RangerPosition | null = null;
  if (slug === 'lp-range') {
    ranger = await readRangerPosition(client, account, rangerTokenId);
  }
  return {
    assets,
    nativeBnbWei,
    nativeBnb: formatUnits(nativeBnbWei, 18),
    ranger,
  };
}
