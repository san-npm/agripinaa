import {
  isDebtCompleteRouter,
  recoveryRouterByAddress,
  ROUTER_ACTIONS,
  routerFor,
  type RouterDeployment,
} from '@agripinaa/shared/contracts';
import type { Hex } from 'viem';

export type ManagedKeyValidity = 'checking' | 'valid' | 'invalid' | 'unknown';
export type ManagedRunnerStatus = 'checking' | 'ready' | 'halted' | 'not-registered' | 'unavailable';

export function managedServiceStatus(
  validity: ManagedKeyValidity,
  recoveryOnly: boolean,
  runner: ManagedRunnerStatus = 'unavailable',
) {
  const sessionValid = validity === 'valid';
  const active = sessionValid && !recoveryOnly && runner === 'ready';
  const label = validity === 'checking'
    ? 'checking…'
    : recoveryOnly
      ? sessionValid
        ? 'recovery only · key live'
        : validity === 'unknown'
          ? 'recovery only · authority unknown'
          : 'recovery only · key stopped'
      : active
        ? 'managing'
        : !sessionValid
          ? validity === 'unknown' ? 'authority unknown' : 'stopped'
          : runner === 'halted'
            ? 'agent halted'
            : runner === 'not-registered'
              ? 'not registered'
              : 'service unavailable';
  return { sessionValid, active, label };
}

export async function readManagedRunnerStatus(
  agent: string | undefined,
  account: string,
  router: string,
): Promise<ManagedRunnerStatus> {
  if (!agent || !isAddressLike(account) || !isAddressLike(router)) return 'unavailable';
  try {
    const params = new URLSearchParams({ account, router });
    const response = await fetch(`/api/managed/${agent}/managed-status?${params}`, { cache: 'no-store' });
    const body = await response.json() as { service?: unknown };
    return response.ok && (body.service === 'ready' || body.service === 'halted' || body.service === 'not-registered')
      ? body.service
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function isAddressLike(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

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

/**
 * The one zero-argument call an owner recovery signs. Execution is active-only:
 * a retired address may be used for reads, but never becomes a transaction
 * target. Version 3 also proves Venus VAI debt is covered atomically.
 */
export function managedUnwindCall(chainId: number, token = 'USDT') {
  const router = routerFor(chainId, token);
  if (!isDebtCompleteRouter(router)) {
    throw new Error(`no debt-complete YieldRouter for ${token} on chain ${chainId}`);
  }
  return { to: router.address, data: ROUTER_ACTIONS.toIdle.selector as Hex };
}
