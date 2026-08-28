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

export interface ManagedRunnerSnapshot {
  service: ManagedRunnerStatus;
  positionTokenId: string | null;
  /** A response arrived, even if the runner reports stale/unavailable health. */
  reachable: boolean;
}

/** Fail closed when parsing the runner's public status response. */
export function managedRunnerSnapshot(
  body: unknown,
  responseOk: boolean,
): ManagedRunnerSnapshot {
  if (typeof body !== 'object' || body === null) {
    return { service: 'unavailable', positionTokenId: null, reachable: responseOk };
  }
  const candidate = body as { service?: unknown; positionTokenId?: unknown };
  const service = responseOk
    && (candidate.service === 'ready'
      || candidate.service === 'halted'
      || candidate.service === 'not-registered')
    ? candidate.service
    : 'unavailable';
  const positionTokenId = responseOk
    && typeof candidate.positionTokenId === 'string'
    && /^[1-9]\d*$/.test(candidate.positionTokenId)
    ? candidate.positionTokenId
    : null;
  return { service, positionTokenId, reachable: responseOk };
}

/** Prefer a fresh exact ID even when runner health is stale; cache only bridges fetch failures. */
export function effectiveManagedPositionTokenId(
  snapshot: ManagedRunnerSnapshot,
  cached: string | null,
): string | null {
  return snapshot.positionTokenId
    ?? (snapshot.reachable ? null : cached);
}

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
  return (await readManagedRunnerSnapshot(agent, account, router)).service;
}

export async function readManagedRunnerSnapshot(
  agent: string | undefined,
  account: string,
  router: string,
): Promise<ManagedRunnerSnapshot> {
  if (!agent || !isAddressLike(account) || !isAddressLike(router)) {
    return { service: 'unavailable', positionTokenId: null, reachable: false };
  }
  try {
    const params = new URLSearchParams({ account, router });
    const response = await fetch(`/api/managed/${agent}/managed-status?${params}`, { cache: 'no-store' });
    return managedRunnerSnapshot(await response.json(), response.ok);
  } catch {
    return { service: 'unavailable', positionTokenId: null, reachable: false };
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
