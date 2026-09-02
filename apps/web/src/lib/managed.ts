import { serializeSession } from '@agripinaa/session-kit/codec';
import { BSC_MAINNET, BSC_TESTNET } from '@agripinaa/shared/chains';
import {
  buildSessionScope,
  describeScope,
  MANAGED_NATIVE_CAP,
  MANAGED_STABLE_CAP,
} from '@agripinaa/session-kit/scope';
import {
  isDebtCompleteRouter,
  isDebtCompleteRouterRuntime,
  isDebtCompleteRouterRuntimeQuorum,
  ROUTER_ACTIONS,
  routerFor,
} from '@agripinaa/shared/contracts';
import { fromBaseUnits } from '@agripinaa/shared/tokens';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  maxUint256,
  parseAbi,
  parseAbiItem,
  type Hex,
} from 'viem';

import { altanaClient } from './altana';
import type { FundingCall } from './funding-bootstrap';
import { bsc, bscTestnet } from './bsc-chain';
import {
  ACCOUNT_HISTORY_CONCURRENCY,
  classifyManagedVenue,
  destinationCodeQuorumProblem,
  destinationProblem,
  MAX_ACCOUNT_HISTORY_ROWS,
  planRotationHistoryRanges,
  type ManagedPolicyDisplay,
  type ManagedVenue,
} from './managed-pure';
import { managedUnwindCall, resolveManagedRouterDeployment } from './managed-router';

export {
  destinationCodeProblem,
  destinationCodeQuorumProblem,
  destinationProblem,
  classifyManagedVenue,
  managedPolicyDisplay,
  MAX_ACCOUNT_HISTORY_CHUNKS,
  MAX_ACCOUNT_HISTORY_ROWS,
  planRotationHistoryRanges,
  shouldOfferManagedHandoffRetry,
  type ManagedVenue,
  type ManagedPolicyDisplay,
} from './managed-pure';

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
    throw new Error(`${action} is still pending on-chain. Check your balance before retrying.`);
  }
  throw new Error(`${action} did not go through (reverted on-chain). No funds were moved.`);
}

// The manager key is fetched and validated in its own module (pin check,
// shape check, point-to-address binding); re-exported so callers are unchanged.
export { fetchManagerKey, type ManagerKeyInfo } from './manager-key';

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

function routerApprovalCalls(router: NonNullable<ReturnType<typeof routerFor>>) {
  return [router.usdt, router.aUsdt, router.vUsdt].map((token) => ({
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [router.address, maxUint256],
    }),
  }));
}

/** A session scoped to ONLY the router's three actions + a USDT and gas cap. */
export function buildManagedScope(opts: { chainId: number; hours: number; token?: string }) {
  const symbol = (opts.token ?? 'USDT') as 'USDT' | 'USDC';
  const router = routerFor(opts.chainId, symbol);
  if (!isDebtCompleteRouter(router)) {
    throw new Error(`no debt-complete YieldRouter deployed for ${symbol} on chain ${opts.chainId}`);
  }
  return buildSessionScope({
    callScopes: [{ to: router.address, signatures: ROUTER_SIGNATURES }],
    // Meter the cap on the token actually being managed, not always USDT.
    // Canonical, server-verifiable permissions. The router itself is
    // drain-proof and moves the account's full balance; a caller-supplied cap
    // made the stored session ambiguous and allowed forged registry records.
    spendCap: { token: symbol, amount: MANAGED_STABLE_CAP, period: 'day' },
    // The account pays its own gas in BNB; without this the relay rejects
    // execute. Kept tight: the agent rotates at most a few times a day (each
    // rotation is one cheap BSC tx), so a small daily allowance is plenty while
    // bounding how much BNB a compromised manager key could burn on no-op calls.
    nativeGasCap: { amount: MANAGED_NATIVE_CAP, period: 'day' },
    expiresInSeconds: opts.hours * 3600,
  });
}

export { describeScope };

type WalletLike = Parameters<ReturnType<typeof altanaClient>['grantSession']>[0]['wallet'] & {
  signer: unknown;
  address: string;
};

async function assertRouterRuntime(chainId: number, router: NonNullable<ReturnType<typeof routerFor>>) {
  const urls = chainId === 97 ? BSC_TESTNET.rpcUrls : BSC_MAINNET.rpcUrls;
  const clients = urls.map((url) => {
    const client = createPublicClient({ chain: chainId === 97 ? bscTestnet : bsc, transport: http(url) });
    return {
      getCode: ({ address }: { address: Hex }) => client.getCode({ address }),
      readContract: (args: Parameters<typeof client.readContract>[0]) => client.readContract(args),
    };
  });
  const attested = chainId === 56
    ? await isDebtCompleteRouterRuntimeQuorum(clients as never, router, 2)
    : await isDebtCompleteRouterRuntime(clients[0]!, router);
  if (!attested) throw new Error('YieldRouter runtime does not match the audited deployment manifest.');
}

/**
 * One batched admin tx that approves the router to move the account's USDT,
 * aToken, and vToken. The router only ever moves these back to the account, so
 * an unlimited approval to it is safe (that is the whole point of the adapter).
 */
export async function approveRouter(
  wallet: WalletLike,
  chainId: number,
  token = 'USDT',
  bootstrap?: {
    calls: readonly FundingCall[];
    preCalls?: readonly FundingCall[];
    merchantUrl?: string;
    onSubmitted?: (callsId: Hex) => void | Promise<void>;
  },
) {
  const router = routerFor(chainId, token);
  if (!isDebtCompleteRouter(router)) {
    throw new Error(`no debt-complete YieldRouter deployed for ${token} on chain ${chainId}`);
  }
  await assertRouterRuntime(chainId, router);
  const calls = routerApprovalCalls(router);
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [...(bootstrap?.calls ?? []), ...calls] as never,
    ...(bootstrap?.preCalls?.length ? { preCalls: bootstrap.preCalls as never } : {}),
    ...(bootstrap?.merchantUrl ? { merchantUrl: bootstrap.merchantUrl } : {}),
    ...(bootstrap?.onSubmitted ? { onSubmitted: bootstrap.onSubmitted } : {}),
  });
  return assertConfirmed(r, 'Router approval');
}

/**
 * User-initiated unwind through the current debt-complete router. Fresh owner
 * approvals and the unwind share one atomic smart-account execution, so a
 * saved retired router is never called and a partial approval cannot be
 * mistaken for recovery.
 */
export async function withdrawToIdle(
  wallet: WalletLike,
  chainId: number,
  token = 'USDT',
) {
  const router = routerFor(chainId, token);
  if (!isDebtCompleteRouter(router)) {
    throw new Error(`Safe ${token} position recovery is unavailable until the debt-complete router is deployed.`);
  }
  await assertRouterRuntime(chainId, router);
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [...routerApprovalCalls(router), managedUnwindCall(chainId, token)],
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
 * Fail closed unless `to` is an externally owned wallet. Call this before any
 * recovery mutation (session revoke or venue unwind), and again immediately
 * before the transfer to protect against both bad input and TOCTOU changes.
 */
export async function assertSafeWithdrawalDestination(account: string, chainId: number, to: Hex) {
  const staticProblem = destinationProblem(to, account, chainId);
  if (staticProblem) throw new Error(staticProblem);
  let liveProblem: string | null;
  try {
    const urls = chainId === 97 ? BSC_TESTNET.rpcUrls : BSC_MAINNET.rpcUrls;
    const settled = await Promise.allSettled(urls.map(async (url) => {
      const client = createPublicClient({
        chain: chainId === 97 ? bscTestnet : bsc,
        transport: http(url),
      });
      return client.getCode({ address: to });
    }));
    const codes = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    liveProblem = destinationCodeQuorumProblem(codes, chainId === 56 ? 2 : 1);
  } catch {
    throw new Error('Could not verify that the destination is an external wallet. Retry when the chain RPC is available.');
  }
  if (liveProblem) throw new Error(liveProblem);
}

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
  symbol = 'USDT',
) {
  if (amountWei <= 0n) throw new Error('Nothing to withdraw.');
  await assertSafeWithdrawalDestination(wallet.address, chainId, to);
  const r = await altanaClient().execute({
    wallet: wallet as WalletLike,
    signer: wallet.signer as never,
    chainId,
    calls: [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amountWei] }) }],
  });
  return assertConfirmed(r, `${symbol} withdrawal`);
}

/** Move native BNB out of the account to an external address (passkey action). */
export async function sendNativeOut(wallet: WalletLike, chainId: number, to: Hex, amountWei: bigint) {
  if (amountWei <= 0n) throw new Error('Nothing to withdraw.');
  await assertSafeWithdrawalDestination(wallet.address, chainId, to);
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

/** Read a managed account's on-chain stablecoin position + native BNB for the dashboard. */
export async function readManagedPosition(
  account: Hex,
  chainId: number,
  token = 'USDT',
  recoveryRouterAddress?: string,
  clientOverride?: ReturnType<typeof createPublicClient>,
  blockNumber?: bigint,
): Promise<ManagedPosition> {
  const router = resolveManagedRouterDeployment(chainId, token, recoveryRouterAddress);
  if (!router) throw new Error(`no matching YieldRouter for ${token} on chain ${chainId}`);
  const client = clientOverride
    ?? createPublicClient({ chain: chainId === 97 ? bscTestnet : bsc, transport: http() });
  const [idle, aUsdt, venusUnderlying, native] = await Promise.all([
    client.readContract({
      address: router.usdt,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    }),
    client.readContract({
      address: router.aUsdt,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    }),
    client.readContract({
      address: router.vUsdt,
      abi: vTokenReadAbi,
      functionName: 'balanceOfUnderlying',
      args: [account],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    }),
    client.getBalance({ address: account, ...(blockNumber !== undefined ? { blockNumber } : {}) }),
  ]);
  const total = idle + aUsdt + venusUnderlying;
  const venue = classifyManagedVenue(idle, aUsdt, venusUnderlying);
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

const venusRateAbi = parseAbi(['function supplyRatePerBlock() view returns (uint256)']);
const aaveReserveAbi = parseAbi([
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]);

export interface VenueApys {
  venusApyBps: number;
  aaveApyBps: number;
}

/**
 * Live supply APY (in bps) for both venues, read client-side so the dashboard
 * can show what the position is earning and why the agent is where it is.
 * Mirrors the agent's own rate math: Venus quotes a WAD per-block rate (simple
 * APR = rate × blocks/year), Aave a RAY-scaled annual liquidity rate. BSC block
 * cadence is derived from two block timestamps, not assumed.
 */
export async function readVenueApys(
  chainId: number,
  token = 'USDT',
  recoveryRouterAddress?: string,
): Promise<VenueApys> {
  const router = resolveManagedRouterDeployment(chainId, token, recoveryRouterAddress);
  if (!router) throw new Error(`no matching YieldRouter for ${token} on chain ${chainId}`);
  const client = createPublicClient({ chain: chainId === 97 ? bscTestnet : bsc, transport: http() });
  const span = 5000n;
  const latest = await client.getBlock();
  const older = await client.getBlock({ blockNumber: latest.number - span });
  const elapsed = Number(latest.timestamp - older.timestamp);
  const blocksPerYear = elapsed > 0 ? Math.round((365 * 24 * 3600 * 5000) / elapsed) : 0;

  const [venusRate, reserve] = await Promise.all([
    client.readContract({ address: router.vUsdt, abi: venusRateAbi, functionName: 'supplyRatePerBlock' }),
    client.readContract({ address: router.aavePool, abi: aaveReserveAbi, functionName: 'getReserveData', args: [router.usdt] }),
  ]);

  const WAD = 10 ** 18;
  const RAY = 10 ** 27;
  return {
    venusApyBps: (Number(venusRate) / WAD) * blocksPerYear * 10_000,
    aaveApyBps: (Number(reserve.currentLiquidityRate) / RAY) * 10_000,
  };
}

// --- Rotation history (the agent's on-chain moves) --------------------------

const ROTATED_EVENT = parseAbiItem(
  'event Rotated(address indexed account, bytes4 indexed action, uint256 usdtAmount)',
);
const ROTATION_LOG_SOURCES = [
  { url: 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3', span: 50_000n },
  { url: 'https://bsc.drpc.org', span: 9_000n },
  { url: 'https://1rpc.io/bnb', span: 9_000n },
] as const;
const ACCOUNT_HISTORY_DEADLINE_MS = 15_000;
const MAX_HISTORY_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const ROTATION_ACTION_LABEL: Record<string, string> = {
  [ROUTER_ACTIONS.toAave.selector]: 'Moved into Aave',
  [ROUTER_ACTIONS.toVenus.selector]: 'Moved into Venus',
  [ROUTER_ACTIONS.toIdle.selector]: 'Unwound to idle USDT',
};

export interface RotationEvent {
  label: string;
  amountUsdt: string;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number | null;
}

export interface RotationHistory {
  events: RotationEvent[];
  scannedFrom: bigint | null;
  scannedTo: bigint | null;
  complete: boolean;
}

/**
 * Permissionless account/router activity, read straight from Rotated events.
 * The scan is newest-first with hard request, row, concurrency and time caps;
 * one failed chunk rejects that source rather than silently fabricating an
 * empty interval. `complete` tells the card whether deployment was reached.
 */
export async function readRotationHistory(
  account: Hex,
  chainId: number,
  token = 'USDT',
  recoveryRouterAddress?: string,
): Promise<RotationHistory> {
  const router = resolveManagedRouterDeployment(chainId, token, recoveryRouterAddress);
  if (!router) return { events: [], scannedFrom: null, scannedTo: null, complete: true };
  const deadline = Date.now() + ACCOUNT_HISTORY_DEADLINE_MS;
  let scan: {
    logs: Awaited<ReturnType<ReturnType<typeof createPublicClient>['getLogs']>>;
    scannedFrom: bigint;
    latest: bigint;
    complete: boolean;
    client: ReturnType<typeof createPublicClient>;
    cancelDeadline: () => void;
  } | null = null;
  let lastError: unknown = new Error('no account-history source available');
  for (const source of ROTATION_LOG_SOURCES) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), remaining);
    try {
      const client = createPublicClient({
        chain: chainId === 97 ? bscTestnet : bsc,
        transport: http(source.url, {
          retryCount: 0,
          timeout: Math.min(5_000, remaining),
          maxResponseBodySize: MAX_HISTORY_RPC_RESPONSE_BYTES,
          fetchOptions: { signal: controller.signal },
        }),
      });
      const latest = await client.getBlockNumber();
      if (Date.now() >= deadline) throw new Error('account history deadline exceeded');
      const plan = planRotationHistoryRanges(router.deployBlock, latest, source.span);
      const logs: Awaited<ReturnType<typeof client.getLogs>> = [];
      let processed = 0;
      for (let i = 0; i < plan.ranges.length; i += ACCOUNT_HISTORY_CONCURRENCY) {
        if (Date.now() >= deadline) throw new Error('account history deadline exceeded');
        const batchRanges = plan.ranges.slice(i, i + ACCOUNT_HISTORY_CONCURRENCY);
        const chunks = await Promise.all(
          batchRanges.map((range) => client.getLogs({
            address: router.address,
            event: ROTATED_EVENT,
            args: { account },
            fromBlock: range.from,
            toBlock: range.to,
          })),
        );
        for (const chunk of chunks) logs.push(...chunk);
        processed += batchRanges.length;
        if (logs.length >= MAX_ACCOUNT_HISTORY_ROWS) break;
      }
      const scannedFrom = plan.ranges[Math.max(0, processed - 1)]?.from ?? latest;
      scan = {
        logs,
        scannedFrom,
        latest,
        complete: plan.complete && processed === plan.ranges.length,
        client,
        cancelDeadline: () => {
          clearTimeout(deadlineTimer);
          controller.abort();
        },
      };
      break;
    } catch (error) {
      clearTimeout(deadlineTimer);
      controller.abort();
      lastError = error;
    }
  }
  if (!scan) throw lastError;
  const logs = scan.logs
    .sort((a, b) => {
      const aBlock = a.blockNumber ?? 0n;
      const bBlock = b.blockNumber ?? 0n;
      if (aBlock !== bBlock) return bBlock > aBlock ? 1 : -1;
      return Number((b.logIndex ?? 0) - (a.logIndex ?? 0));
    })
    .slice(0, MAX_ACCOUNT_HISTORY_ROWS);
  const blocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
  const tsByBlock = new Map<bigint, number>();
  for (let i = 0; i < blocks.length; i += ACCOUNT_HISTORY_CONCURRENCY) {
    if (Date.now() >= deadline) break;
    await Promise.all(blocks.slice(i, i + ACCOUNT_HISTORY_CONCURRENCY).map(async (bn) => {
      try {
        const blk = await scan.client.getBlock({ blockNumber: bn });
        tsByBlock.set(bn, Number(blk.timestamp) * 1000);
      } catch {
        /* leave undated */
      }
    }));
  }
  const events = logs.flatMap((l) => {
    if (!("args" in l) || !l.transactionHash) return [];
    const args = l.args as { action?: string; usdtAmount?: bigint };
    return [{
      label: ROTATION_ACTION_LABEL[(args.action ?? '').toLowerCase()] ?? 'Rotation',
      amountUsdt: fromBaseUnits(args.usdtAmount ?? BigInt(0), 18),
      txHash: l.transactionHash,
      blockNumber: l.blockNumber ?? BigInt(0),
      logIndex: l.logIndex ?? 0,
      timestamp: l.blockNumber != null ? (tsByBlock.get(l.blockNumber) ?? null) : null,
    }];
  });
  scan.cancelDeadline();
  return {
    events,
    scannedFrom: scan.scannedFrom,
    scannedTo: scan.latest,
    complete: scan.complete,
  };
}

/** The agent's live rationale for where a managed position sits. */
export function rotationRationale(
  venue: Exclude<ManagedVenue, 'split'>,
  apys: VenueApys,
  policy: ManagedPolicyDisplay,
) {
  const current = venue === 'venus' ? apys.venusApyBps : venue === 'aave' ? apys.aaveApyBps : null;
  const other = venue === 'venus' ? apys.aaveApyBps : venue === 'aave' ? apys.venusApyBps : null;
  const otherName = venue === 'venus' ? 'Aave' : 'Venus';
  const edgeBps = current != null && other != null ? other - current : Math.abs(apys.venusApyBps - apys.aaveApyBps);
  return { currentApyBps: current, edgeBps, otherName, ...policy };
}
