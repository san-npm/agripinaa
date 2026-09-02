'use client';

import { PANCAKE_V3_FACTORY_BSC } from '@agripinaa/shared/funding';
import { listActiveAccountSessionPublicKeys } from '@agripinaa/session-kit/verify';
import {
  PANCAKE_V3_POSITION_MANAGER,
  type ManagedStrategySlug,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { parseAbi, zeroAddress, type Hex } from 'viem';

import { altanaClient } from './altana';
import { readBscQuorumAtCommonBlock } from './bsc-public-client';
import { assertSafeWithdrawalDestination } from './managed';
import {
  buildRangerExitCalls,
  buildStrategyTokenRecoveryCalls,
  PANCAKE_POSITION_MANAGER_ABI,
} from './strategy-recovery-pure';
import { readStrategyAccountPosition } from './strategy-position';
import {
  listStoredSessions,
  markRevoked,
  type StoredSessionMeta,
} from './session-store';

type WalletLike = Awaited<ReturnType<ReturnType<typeof altanaClient>['recoverFromPasskey']>>;

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);
const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)',
]);
const EXIT_TWAP_SECONDS = 60;
const MAX_TICK_DEVIATION = 100;
const EXIT_DEADLINE_SECONDS = 600;

type RangerPositionTuple = readonly [
  bigint, Hex, Hex, Hex, number, number, number, bigint, bigint, bigint, bigint, bigint,
];

interface RangerExitSnapshot {
  owner: Hex;
  factory: Hex;
  weth: Hex;
  position: RangerPositionTuple;
  pool: Hex;
  spotTick: number | null;
  tickCumulatives: readonly bigint[];
  quotedExit?: readonly [bigint, bigint];
}

function snapshotFingerprint(value: RangerExitSnapshot): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item);
}

async function readRangerExitSnapshot(
  account: Hex,
  tokenId: bigint,
  deadline: bigint,
): Promise<RangerExitSnapshot> {
  return readBscQuorumAtCommonBlock(async (client, blockNumber) => {
    const [owner, factory, weth, position] = await Promise.all([
      client.readContract({
        address: PANCAKE_V3_POSITION_MANAGER,
        abi: PANCAKE_POSITION_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
        blockNumber,
      }),
      client.readContract({
        address: PANCAKE_V3_POSITION_MANAGER,
        abi: PANCAKE_POSITION_MANAGER_ABI,
        functionName: 'factory',
        blockNumber,
      }),
      client.readContract({
        address: PANCAKE_V3_POSITION_MANAGER,
        abi: PANCAKE_POSITION_MANAGER_ABI,
        functionName: 'WETH9',
        blockNumber,
      }),
      client.readContract({
        address: PANCAKE_V3_POSITION_MANAGER,
        abi: PANCAKE_POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [tokenId],
        blockNumber,
      }),
    ]);
    const typedPosition = position as RangerPositionTuple;
    if (typedPosition[7] === 0n) {
      return {
        owner,
        factory,
        weth,
        position: typedPosition,
        pool: zeroAddress,
        spotTick: null,
        tickCumulatives: [],
      };
    }
    const pool = await client.readContract({
      address: PANCAKE_V3_FACTORY_BSC,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [typedPosition[2], typedPosition[3], typedPosition[4]],
      blockNumber,
    });
    if (pool === zeroAddress) throw new Error('Ranger pool is not registered');
    const [slot0, observation, simulated] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0', blockNumber }),
      client.readContract({
        address: pool,
        abi: POOL_ABI,
        functionName: 'observe',
        args: [[EXIT_TWAP_SECONDS, 0]],
        blockNumber,
      }),
      client.simulateContract({
        address: PANCAKE_V3_POSITION_MANAGER,
        abi: PANCAKE_POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [{
          tokenId,
          liquidity: typedPosition[7],
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        }],
        account,
        blockNumber,
      }),
    ]);
    return {
      owner,
      factory,
      weth,
      position: typedPosition,
      pool,
      spotTick: slot0[1],
      tickCumulatives: observation[0],
      quotedExit: simulated.result,
    };
  }, snapshotFingerprint);
}

function assertConfirmed(
  result: { status: 'PENDING' | 'CONFIRMED' | 'FAILED' },
  action: string,
) {
  if (result.status === 'CONFIRMED') return;
  throw new Error(result.status === 'PENDING'
    ? `${action} is still pending on-chain. Retry only after checking the account.`
    : `${action} reverted on-chain. No later recovery step was submitted.`);
}

/**
 * Stop every live session the account authorizes before moving shared
 * inventory. The authoritative list is reconstructed from matching account
 * and KeyStore quorum snapshots, so sessions created in another browser are
 * not missed. A later relay failure remains safely retryable.
 */
export async function stopAllAccountSessions(
  wallet: WalletLike,
  account: Hex,
  chainId: number,
  requiredSession: StoredSessionMeta,
): Promise<number> {
  const stored = listStoredSessions();
  const records = stored.some((session) => session.id === requiredSession.id)
    ? stored
    : [...stored, requiredSession];
  const accountRecords = records.filter((session) =>
    session.chainId === chainId
    && session.account.toLowerCase() === account.toLowerCase());
  const publicKeys = await listActiveAccountSessionPublicKeys({ chainId, account });
  let stopped = 0;
  for (const publicKey of publicKeys) {
    const result = await altanaClient().revokeSession({
      wallet,
      signer: wallet.signer,
      chainId,
      session: publicKey as Parameters<ReturnType<typeof altanaClient>['revokeSession']>[0]['session'],
    });
    assertConfirmed(result, 'Shared-account session revocation');
    stopped += 1;
  }
  const remaining = await listActiveAccountSessionPublicKeys({ chainId, account });
  if (remaining.length !== 0) {
    throw new Error('New or still-active account authority was detected. Recovery stopped before moving funds.');
  }
  for (const record of accountRecords) markRevoked(record.id);
  return stopped;
}

/**
 * Owner-only Ranger exit. The manager/factory/pair are re-attested, the spot
 * tick must agree with the one-minute TWAP, and the simulated exit is protected
 * by the same 90% per-leg minima as the automated agent.
 */
export async function closeRangerPosition(
  wallet: WalletLike,
  account: Hex,
  tokenId: bigint,
): Promise<boolean> {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + EXIT_DEADLINE_SECONDS);
  const snapshot = await readRangerExitSnapshot(account, tokenId, deadline);
  const { owner, factory, weth, position } = snapshot;
  if (owner.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`Ranger NFT #${tokenId} is not owned by this strategy account.`);
  }
  if (factory.toLowerCase() !== PANCAKE_V3_FACTORY_BSC.toLowerCase()
      || weth.toLowerCase() !== TOKENS_BSC.WBNB!.address.toLowerCase()) {
    throw new Error('Pancake position-manager runtime configuration does not match the pinned deployment.');
  }
  const token0 = position[2];
  const token1 = position[3];
  const expectedPair = new Set([
    TOKENS_BSC.WBNB!.address.toLowerCase(),
    TOKENS_BSC.USDT!.address.toLowerCase(),
  ]);
  if (!expectedPair.has(token0.toLowerCase())
      || !expectedPair.has(token1.toLowerCase())
      || token0.toLowerCase() === token1.toLowerCase()) {
    throw new Error(`Ranger NFT #${tokenId} is not the pinned WBNB/USDT pair.`);
  }
  const liquidity = position[7];
  const owed0 = position[10];
  const owed1 = position[11];
  if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return false;

  const quotedExit = snapshot.quotedExit;
  if (liquidity > 0n) {
    if (snapshot.pool === zeroAddress || snapshot.spotTick === null || !quotedExit) {
      throw new Error('The quorum Ranger exit quote is incomplete.');
    }
    const twapTick = Math.trunc(
      Number(snapshot.tickCumulatives[1]! - snapshot.tickCumulatives[0]!) / EXIT_TWAP_SECONDS,
    );
    if (Math.abs(snapshot.spotTick - twapTick) > MAX_TICK_DEVIATION) {
      throw new Error('Ranger exit paused because the pool spot price is too far from its one-minute TWAP. Retry later.');
    }
  }

  const result = await altanaClient().execute({
    wallet,
    signer: wallet.signer,
    chainId: 56,
    calls: buildRangerExitCalls({ account, tokenId, liquidity, quotedExit, deadline }),
  });
  assertConfirmed(result, 'Ranger close and collect');
  return true;
}

/** Reset every shared-account venue approval, then sweep exact freshly-read strategy balances. */
export async function recoverStrategyTokens(
  wallet: WalletLike,
  slug: ManagedStrategySlug,
  account: Hex,
  destination: Hex,
): Promise<string[]> {
  await assertSafeWithdrawalDestination(account, 56, destination);
  const fresh = await readStrategyAccountPosition(slug, account);
  const balances = Object.fromEntries(fresh.assets.map((asset) => [asset.symbol, asset.wei]));
  const symbols = fresh.assets.filter((asset) => asset.wei > 0n).map((asset) => asset.symbol);
  if (symbols.length === 0) throw new Error('No strategy tokens are available to recover.');
  const result = await altanaClient().execute({
    wallet,
    signer: wallet.signer,
    chainId: 56,
    calls: buildStrategyTokenRecoveryCalls(slug, destination, balances),
  });
  assertConfirmed(result, 'Strategy token recovery');
  return symbols;
}
