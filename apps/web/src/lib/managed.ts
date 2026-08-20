import { serializeSession } from '@agripinaa/session-kit/codec';
import { buildSessionScope, describeScope } from '@agripinaa/session-kit/scope';
import { ROUTER_ACTIONS, routerFor } from '@agripinaa/shared/contracts';
import { fromBaseUnits } from '@agripinaa/shared/tokens';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  maxUint256,
  parseAbi,
  type Hex,
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

import { altanaClient } from './altana';

const ROUTER_SIGNATURES = Object.values(ROUTER_ACTIONS).map((a) => a.signature);

export interface ManagerKeyInfo {
  agent: string;
  publicKey: Hex;
  address: Hex;
}

/** Fetch the agent's public manager key (via the server proxy). */
export async function fetchManagerKey(agent: string): Promise<ManagerKeyInfo> {
  const res = await fetch(`/api/managed/${agent}/manager-key`);
  const body = (await res.json().catch(() => ({}))) as Partial<ManagerKeyInfo> & { error?: string };
  if (!res.ok || !body.publicKey) {
    throw new Error(body.error ?? `manager key unavailable (${res.status})`);
  }
  return { agent, publicKey: body.publicKey, address: body.address as Hex };
}

/**
 * A verify-only session signer: grantSession reads only publicKey/address, so
 * the agent's private key never has to enter the browser to authorize it.
 */
export function verifyOnlyStub(address: Hex, publicKey: Hex) {
  return {
    type: 'privateKey' as const,
    address,
    publicKey,
    signDigest: () => {
      throw new Error('verify-only stub: the agent manager key is off-browser');
    },
  };
}

/** A session scoped to ONLY the router's three actions + a USDT and gas cap. */
export function buildManagedScope(opts: { chainId: number; capUsdt: string; hours: number }) {
  const router = routerFor(opts.chainId);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${opts.chainId}`);
  return buildSessionScope({
    callScopes: [{ to: router.address, signatures: ROUTER_SIGNATURES }],
    spendCap: { token: 'USDT', amount: opts.capUsdt, period: 'day' },
    // The account pays its own gas in BNB; without this the relay rejects execute.
    nativeGasCap: { amount: '0.02', period: 'day' },
    expiresInSeconds: opts.hours * 3600,
  });
}

export { describeScope };

type WalletLike = Parameters<ReturnType<typeof altanaClient>['grantSession']>[0]['wallet'] & {
  signer: unknown;
  address: string;
};

/**
 * One batched admin tx that approves the router to move the account's USDT,
 * aToken, and vToken. The router only ever moves these back to the account, so
 * an unlimited approval to it is safe (that is the whole point of the adapter).
 */
export async function approveRouter(wallet: WalletLike, chainId: number) {
  const router = routerFor(chainId);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${chainId}`);
  const calls = [router.usdt, router.aUsdt, router.vUsdt].map((token) => ({
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [router.address, maxUint256],
    }),
  }));
  return altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls,
  });
}

/** User-initiated unwind: pull everything back to plain USDT in the account. */
export async function withdrawToIdle(wallet: WalletLike, chainId: number) {
  const router = routerFor(chainId);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${chainId}`);
  return altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [{ to: router.address, data: ROUTER_ACTIONS.toIdle.selector as Hex }],
  });
}

/** Register the account for the agent to manage (session is the authorization). */
export async function registerManaged(
  agent: string,
  payload: { account: Hex; chainId: number; session: unknown },
): Promise<{ ok: boolean; managedCount: number }> {
  // Strip the (stub) signer before sending; the runner needs only the public half.
  const session = payload.session as Record<string, unknown>;
  const { signer: _signer, ...publicSession } = session;
  void _signer;
  const res = await fetch(`/api/managed/${agent}/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: serializeSession({ account: payload.account, chainId: payload.chainId, session: publicSession }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; managedCount?: number; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `registration failed (${res.status})`);
  return { ok: true, managedCount: body.managedCount ?? 0 };
}

const vTokenReadAbi = parseAbi([
  'function balanceOfUnderlying(address owner) view returns (uint256)',
]);

export type ManagedVenue = 'idle' | 'venus' | 'aave';

export interface ManagedPosition {
  idleUsdt: string;
  venusUsdt: string;
  aaveUsdt: string;
  totalUsdt: string;
  venue: ManagedVenue;
}

/** Read a managed account's on-chain USDT position for the dashboard. */
export async function readManagedPosition(account: Hex, chainId: number): Promise<ManagedPosition> {
  const router = routerFor(chainId);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${chainId}`);
  const client = createPublicClient({ chain: chainId === 97 ? bscTestnet : bsc, transport: http() });
  const [idle, aUsdt, venusUnderlying] = await Promise.all([
    client.readContract({ address: router.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: router.aUsdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: router.vUsdt, abi: vTokenReadAbi, functionName: 'balanceOfUnderlying', args: [account] }),
  ]);
  const total = idle + aUsdt + venusUnderlying;
  const venue: ManagedVenue = venusUnderlying > aUsdt && venusUnderlying > idle
    ? 'venus'
    : aUsdt > idle
      ? 'aave'
      : idle > 0n
        ? 'idle'
        : venusUnderlying > 0n
          ? 'venus'
          : aUsdt > 0n
            ? 'aave'
            : 'idle';
  return {
    idleUsdt: fromBaseUnits(idle, 18),
    venusUsdt: fromBaseUnits(venusUnderlying, 18),
    aaveUsdt: fromBaseUnits(aUsdt, 18),
    totalUsdt: fromBaseUnits(total, 18),
    venue,
  };
}
