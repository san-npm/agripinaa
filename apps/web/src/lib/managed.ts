import { serializeSession } from '@agripinaa/session-kit/codec';
import { buildSessionScope, describeScope } from '@agripinaa/session-kit/scope';
import { ROUTER_ACTIONS, routerFor } from '@agripinaa/shared/contracts';
import { fromBaseUnits } from '@agripinaa/shared/tokens';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  maxUint256,
  parseAbi,
  zeroAddress,
  type Hex,
} from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

import { altanaClient } from './altana';

const ROUTER_SIGNATURES = Object.values(ROUTER_ACTIONS).map((a) => a.signature);

interface ExecResult {
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  transactionHash?: Hex;
}

/**
 * Turn a relay result into success/failure the caller can trust. The SDK does
 * NOT throw on a reverted or timed-out bundle, so without this a FAILED/PENDING
 * withdrawal would be reported to the user as done. Only CONFIRMED passes.
 */
function assertConfirmed<T extends ExecResult>(result: T, action: string): T {
  if (result.status === 'CONFIRMED') return result;
  if (result.status === 'PENDING') {
    throw new Error(`${action} is still pending on-chain — check your balance before retrying.`);
  }
  throw new Error(`${action} did not go through (reverted on-chain). No funds were moved.`);
}

/**
 * Reject destinations that would lose funds or make no sense: not an address,
 * the zero address (a native send there is an irrecoverable burn), a known
 * contract (router/tokens), or the account itself. Returns a user-facing
 * message, or null if the destination is a safe external wallet.
 */
export function destinationProblem(to: string, account: string, chainId: number): string | null {
  if (!isAddress(to)) return 'Enter a valid destination address.';
  const lc = to.toLowerCase();
  if (lc === zeroAddress) return 'That is the zero address — funds sent there are burned.';
  if (lc === account.toLowerCase()) return 'That is this same account — enter an external wallet.';
  const router = routerFor(chainId);
  if (router && [router.address, router.usdt, router.aUsdt, router.vUsdt].some((a) => a.toLowerCase() === lc)) {
    return 'That is a contract address, not a wallet.';
  }
  return null;
}

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
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls,
  });
  return assertConfirmed(r, 'Router approval');
}

/** User-initiated unwind: pull everything back to plain USDT in the account. */
export async function withdrawToIdle(wallet: WalletLike, chainId: number) {
  const router = routerFor(chainId);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${chainId}`);
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [{ to: router.address, data: ROUTER_ACTIONS.toIdle.selector as Hex }],
  });
  return assertConfirmed(r, 'Unwind');
}

/**
 * BNB kept back so the withdrawal tx can pay its own gas. Sized for a
 * smart-account UserOp (heavier than a plain EOA transfer) with headroom for
 * a moderate gas-price spike; if it is still short the tx simply reverts and
 * the user retries, so no funds are ever at risk.
 */
export const WITHDRAW_GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 BNB

/**
 * Move an exact amount of an ERC-20 (here: USDT) out of the account to an
 * external address. This is a passkey (admin) action on the user's own
 * account, so only the account owner can ever call it.
 */
export async function sendTokenOut(
  wallet: WalletLike,
  chainId: number,
  token: Hex,
  to: Hex,
  amountWei: bigint,
) {
  const problem = destinationProblem(to, wallet.address, chainId);
  if (problem) throw new Error(problem);
  if (amountWei <= 0n) throw new Error('Nothing to withdraw.');
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amountWei] }) }],
  });
  return assertConfirmed(r, 'USDT withdrawal');
}

/** Move native BNB out of the account to an external address (passkey action). */
export async function sendNativeOut(wallet: WalletLike, chainId: number, to: Hex, amountWei: bigint) {
  const problem = destinationProblem(to, wallet.address, chainId);
  if (problem) throw new Error(problem);
  if (amountWei <= 0n) throw new Error('Nothing to withdraw.');
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [{ to, value: amountWei }],
  });
  return assertConfirmed(r, 'BNB withdrawal');
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
  /** Raw balances for exact withdrawals (no float rounding). */
  idleWei: bigint;
  deployedWei: bigint;
  nativeWei: bigint;
  nativeBnb: string;
}

/** Read a managed account's on-chain USDT position + native BNB for the dashboard. */
export async function readManagedPosition(account: Hex, chainId: number): Promise<ManagedPosition> {
  const router = routerFor(chainId);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${chainId}`);
  const client = createPublicClient({ chain: chainId === 97 ? bscTestnet : bsc, transport: http() });
  const [idle, aUsdt, venusUnderlying, native] = await Promise.all([
    client.readContract({ address: router.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: router.aUsdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: router.vUsdt, abi: vTokenReadAbi, functionName: 'balanceOfUnderlying', args: [account] }),
    client.getBalance({ address: account }),
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
    idleWei: idle,
    deployedWei: aUsdt + venusUnderlying,
    nativeWei: native,
    nativeBnb: fromBaseUnits(native, 18),
  };
}
