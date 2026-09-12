import { parseAbi } from 'viem';

/**
 * The concentrated-liquidity venues Ranger can run on. Both expose the
 * Uniswap v3 periphery: the same NonfungiblePositionManager ABI for mint,
 * decreaseLiquidity and collect, the same factory getPool, the same pool
 * reads. They differ in three places, which is all a venue record holds:
 * the addresses, the fee tiers the pair is deployed at, and the width of
 * `feeProtocol` in `slot0` (uint8 on Uniswap, uint32 on PancakeSwap), which
 * changes the ABI a pool is read with.
 *
 * `LP_RANGE_VENUE` selects the venue for the agent's own capital;
 * PancakeSwap stays the default so the live runner is unchanged. Managed
 * mandates keep their PancakeSwap session policy
 * (`packages/shared/src/managed-strategies.ts`); a venue there is a policy
 * change that must be re-verified on-chain, not an env var.
 */
const POOL_ABI_SHARED = [
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)',
] as const;

const PANCAKE_POOL_ABI = parseAbi([
  ...POOL_ABI_SHARED,
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
] as const);

const UNISWAP_POOL_ABI = parseAbi([
  ...POOL_ABI_SHARED,
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
] as const);

export interface LpVenue {
  name: 'pancakeswap-v3' | 'uniswap-v3';
  label: string;
  positionManager: `0x${string}`;
  factory: `0x${string}`;
  /** Fee tiers the WBNB/USDT pair is deployed at, deepest first at probe time. */
  feeTiers: readonly number[];
  poolAbi: typeof PANCAKE_POOL_ABI | typeof UNISWAP_POOL_ABI;
}

export const LP_VENUES: Record<LpVenue['name'], LpVenue> = {
  /*
   * Probed 2026-08-18 with tsx + viem readContract on https://bsc-rpc.publicnode.com:
   *   NPM.factory() -> 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865 (matches expected factory)
   *   NPM.WETH9()  -> 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c (WBNB, matches TOKENS_BSC)
   * Pool probes, same date and RPC, factory.getPool(WBNB, USDT, fee):
   *   fee 500  -> 0x36696169C63e42cd08ce11f5deeBbCeBae652050 liquidity 1.19e24 tickSpacing 10
   *   fee 100  -> 0x172fcD41E0913e95784454622d1c3724f546f849 liquidity 8.96e24 tickSpacing 1
   *   fee 2500 -> 0x1401ff943D08a7E098328C1d3a9d388923B115D2 liquidity 2.00e22 tickSpacing 50
   * All three report token0 = USDT, token1 = WBNB.
   */
  'pancakeswap-v3': {
    name: 'pancakeswap-v3',
    label: 'PancakeSwap V3',
    positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    feeTiers: [500, 100, 2500],
    poolAbi: PANCAKE_POOL_ABI,
  },
  /*
   * Addresses from developers.uniswap.org, v3 BNB deployments, read 2026-09-12.
   * Probed 2026-09-12 with tsx + viem readContract on https://bsc-rpc.publicnode.com (block 121491250):
   *   NPM.factory() -> 0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7 (matches the published factory)
   *   NPM.WETH9()  -> 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c (WBNB, matches TOKENS_BSC)
   * factory.getPool(WBNB, USDT, fee), all token0 = USDT, token1 = WBNB:
   *   fee 500   -> 0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869 liquidity 1.14e24 tickSpacing 10
   *   fee 100   -> 0x47a90A2d92A8367A91EfA1906bFc8c1E05bf10c4 liquidity 1.35e23 tickSpacing 1
   *   fee 3000  -> 0x7862D9B4bE2156B15d54F41ee4EDE2d5b0b455e4 liquidity 3.50e22 tickSpacing 60
   *   fee 10000 -> 0x4d170f8714367C44787AE98259CE8Adb72240067 liquidity 1.81e22 tickSpacing 200
   * slot0().feeProtocol read 68 and 102, inside uint8 as the Uniswap layout says.
   */
  'uniswap-v3': {
    name: 'uniswap-v3',
    label: 'Uniswap v3',
    positionManager: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    feeTiers: [500, 100, 3000, 10000],
    poolAbi: UNISWAP_POOL_ABI,
  },
};

/** The venue named by `LP_RANGE_VENUE`; an unknown name is a startup error, not a silent default. */
export function selectLpVenue(name = process.env.LP_RANGE_VENUE): LpVenue {
  if (!name) return LP_VENUES['pancakeswap-v3'];
  const venue = LP_VENUES[name as LpVenue['name']];
  if (!venue) throw new Error(`LP_RANGE_VENUE=${name} is not one of ${Object.keys(LP_VENUES).join(', ')}`);
  return venue;
}
