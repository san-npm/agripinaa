import {
  MANAGED_STRATEGIES,
  managedStrategyFor,
  PANCAKE_V3_POSITION_MANAGER,
  type ManagedStrategySlug,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';

export const PANCAKE_POSITION_MANAGER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function WETH9() view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)',
]);

export interface RecoveryCall {
  to: Hex;
  data: Hex;
}

const EXIT_MIN_BPS = 9_000n;
const BPS_DENOMINATOR = 10_000n;
const MAX_UINT128 = (1n << 128n) - 1n;

/** Keep the owner exit at least as strict as Ranger's automated exit. */
export function rangerExitMinimums(quoted: readonly [bigint, bigint]): readonly [bigint, bigint] {
  return [
    quoted[0] * EXIT_MIN_BPS / BPS_DENOMINATOR,
    quoted[1] * EXIT_MIN_BPS / BPS_DENOMINATOR,
  ];
}

/** Close first, then collect principal and fees back to the strategy account. */
export function buildRangerExitCalls(input: {
  account: Hex;
  tokenId: bigint;
  liquidity: bigint;
  quotedExit?: readonly [bigint, bigint];
  deadline: bigint;
}): RecoveryCall[] {
  const calls: RecoveryCall[] = [];
  if (input.liquidity > 0n) {
    if (!input.quotedExit) throw new Error('Ranger exit quote is required for live liquidity.');
    const [amount0Min, amount1Min] = rangerExitMinimums(input.quotedExit);
    calls.push({
      to: PANCAKE_V3_POSITION_MANAGER,
      data: encodeFunctionData({
        abi: PANCAKE_POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [{
          tokenId: input.tokenId,
          liquidity: input.liquidity,
          amount0Min,
          amount1Min,
          deadline: input.deadline,
        }],
      }),
    });
  }
  calls.push({
    to: PANCAKE_V3_POSITION_MANAGER,
    data: encodeFunctionData({
      abi: PANCAKE_POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{
        tokenId: input.tokenId,
        recipient: input.account,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    }),
  });
  return calls;
}

/** Reset every shared-account strategy allowance, then sweep this strategy's freshly read balances. */
export function buildStrategyTokenRecoveryCalls(
  slug: ManagedStrategySlug,
  destination: Hex,
  balances: Readonly<Record<string, bigint>>,
): RecoveryCall[] {
  const strategy = managedStrategyFor(slug);
  if (!strategy) throw new Error(`Unknown managed strategy ${slug}.`);
  const seenApprovals = new Set<string>();
  const approvalCalls = Object.values(MANAGED_STRATEGIES)
    .flatMap(({ approvals }) => approvals)
    .flatMap(({ token, spender }) => {
      const address = TOKENS_BSC[token]?.address;
      if (!address) throw new Error(`Unknown strategy token ${token}.`);
      const key = `${address.toLowerCase()}:${spender.toLowerCase()}`;
      if (seenApprovals.has(key)) return [];
      seenApprovals.add(key);
      return [{
        to: address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, 0n],
        }),
      }];
    });
  const transferCalls = Object.entries(balances).flatMap(([symbol, amount]) => {
    const token = TOKENS_BSC[symbol];
    if (!token) throw new Error(`Unknown strategy token ${symbol}.`);
    if (amount <= 0n) return [];
    return [{
      to: token.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [destination, amount],
      }),
    }];
  });
  return [...approvalCalls, ...transferCalls];
}
