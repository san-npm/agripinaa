import {
  recoveryRouterByAddress,
  ROUTER_ACTIONS,
  routerFor,
  type RouterDeployment,
} from '@agripinaa/shared/contracts';
import type { Hex } from 'viem';

/**
 * Resolve either today's active router or one exact recovery-only address.
 * The address path still validates chain + token, so a malformed saved scope
 * cannot send a USDC recovery to a USDT router (or cross networks).
 */
export function resolveManagedRouterDeployment(
  chainId: number,
  token = 'USDT',
  recoveryRouterAddress?: string,
): RouterDeployment | undefined {
  const router = recoveryRouterAddress
    ? recoveryRouterByAddress(recoveryRouterAddress)
    : routerFor(chainId, token);
  return router?.chainId === chainId && router.symbol === token ? router : undefined;
}

/** The one zero-argument call an owner recovery signs. */
export function managedUnwindCall(chainId: number, token = 'USDT', recoveryRouterAddress?: string) {
  const router = resolveManagedRouterDeployment(chainId, token, recoveryRouterAddress);
  if (!router) throw new Error(`no matching YieldRouter for ${token} on chain ${chainId}`);
  return { to: router.address, data: ROUTER_ACTIONS.toIdle.selector as Hex };
}
