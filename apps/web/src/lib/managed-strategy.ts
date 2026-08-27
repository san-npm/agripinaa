'use client';

import {
  managedStrategyFor,
  type ManagedStrategySlug,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';

import { altanaClient } from './altana';

export { buildStrategyScope, describeScope } from './strategy-scope';

type WalletLike = Parameters<ReturnType<typeof altanaClient>['grantSession']>[0]['wallet'] & {
  signer: unknown;
};

/**
 * Owner-authorized approvals for the immutable venues in the public policy.
 * No approve selector is delegated to the agent session itself.
 */
export async function approveStrategyVenues(
  wallet: WalletLike,
  slug: ManagedStrategySlug,
  chainId = 56,
) {
  const strategy = managedStrategyFor(slug);
  if (!strategy) throw new Error(`no managed strategy policy for ${slug}`);
  if (chainId !== 56) throw new Error('managed strategy execution is deployed only on BNB Chain mainnet');
  const seen = new Set<string>();
  const calls = strategy.approvals.flatMap(({ token, spender }) => {
    const address = TOKENS_BSC[token]?.address;
    if (!address) throw new Error(`unknown strategy token ${token}`);
    const key = `${address.toLowerCase()}:${spender.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      to: address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
      }),
    }];
  });
  const result = await altanaClient().execute({
    wallet: wallet as never,
    signer: wallet.signer as never,
    chainId,
    calls,
  });
  if (result.status !== 'CONFIRMED') {
    throw new Error(
      result.status === 'PENDING'
        ? 'Strategy approvals are still pending on-chain.'
        : 'Strategy approvals reverted on-chain.',
    );
  }
  return result;
}
