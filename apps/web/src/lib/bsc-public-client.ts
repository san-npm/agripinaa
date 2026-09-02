'use client';

import { BSC_MAINNET } from '@agripinaa/shared/chains';
import {
  createPublicClient,
  fallback,
  http,
  parseAbi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';

import { bsc } from './bsc-chain';

export interface BscReceiptClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>;
}

export interface BscNonceClient {
  getBlockNumber(): Promise<bigint>;
  readContract(args: {
    address: Address;
    abi: typeof ACCOUNT_NONCE_ABI;
    functionName: 'getNonce';
    args: readonly [bigint];
    blockNumber: bigint;
  }): Promise<unknown>;
}

const ACCOUNT_NONCE_ABI = parseAbi(['function getNonce(uint192 seqKey) view returns (uint256)']);

/**
 * Receipt-capable endpoints operated by distinct organisations. The two BNB
 * dataseed hostnames share an operator, so they must never be counted as two
 * votes for the funding proof.
 */
export const BSC_RECEIPT_RPC_SOURCES = [
  { operator: 'BNB Chain', url: 'https://bsc-dataseed.bnbchain.org' },
  { operator: 'dRPC', url: 'https://bsc.drpc.org' },
  { operator: 'Blast', url: 'https://bsc-mainnet.public.blastapi.io' },
  { operator: 'bloXroute', url: 'https://bsc.rpc.blxrbdn.com' },
] as const;

/**
 * Latest-state client for funding quotes and post-receipt balance reads.
 * Explicit transports matter here: viem's bare http() selects the first chain
 * URL and never gets a chance to recover when that provider rejects a method.
 */
export function createBscPublicClient() {
  return createPublicClient({
    chain: bsc,
    transport: fallback(
      BSC_MAINNET.rpcUrls.map((url) => http(url, { retryCount: 0, timeout: 5_000 })),
    ),
  });
}

export type BscPublicClient = ReturnType<typeof createBscPublicClient>;

function independentReadClients(): BscPublicClient[] {
  return BSC_RECEIPT_RPC_SOURCES.map(({ url }) => createPublicClient({
    chain: bsc,
    transport: http(url, { retryCount: 0, timeout: 5_000 }),
  })) as unknown as BscPublicClient[];
}

/**
 * Run a security-sensitive read at one common block and accept only a
 * byte-equivalent result returned by independent RPC operators.
 */
export async function readBscQuorumAtCommonBlock<T>(
  read: (client: BscPublicClient, blockNumber: bigint) => Promise<T>,
  fingerprint: (value: T) => string,
  options: { clients?: readonly BscPublicClient[]; quorum?: number } = {},
): Promise<T> {
  const clients = options.clients ?? independentReadClients();
  const quorum = options.quorum ?? 2;
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > clients.length) {
    throw new Error('invalid BSC read quorum policy');
  }
  const heads = (await Promise.allSettled(clients.map((client) => client.getBlockNumber())))
    .flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (heads.length < quorum) throw new Error('BSC read quorum unavailable');
  const blockNumber = heads[Math.floor(heads.length / 2)]!;
  const values = (await Promise.allSettled(clients.map((client) => read(client, blockNumber))))
    .flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const groups = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = fingerprint(value);
    const group = groups.get(key) ?? { value, count: 0 };
    group.count += 1;
    groups.set(key, group);
    if (group.count >= quorum) return group.value;
  }
  throw new Error('BSC read quorum unavailable or disagreed');
}

function receiptClients(): BscReceiptClient[] {
  return BSC_RECEIPT_RPC_SOURCES.map(({ url }) => createPublicClient({
    chain: bsc,
    transport: http(url, { retryCount: 0, timeout: 5_000 }),
  }));
}

function nonceClients(): BscNonceClient[] {
  return BSC_RECEIPT_RPC_SOURCES.map(({ url }) => createPublicClient({
    chain: bsc,
    transport: http(url, { retryCount: 0, timeout: 5_000 }),
  }) as BscNonceClient);
}

/** Read one account nonce at a common block and require two matching providers. */
export async function readBscNonceQuorum(
  account: Address,
  seqKey: bigint,
  options: { clients?: readonly BscNonceClient[]; quorum?: number } = {},
): Promise<bigint> {
  const clients = options.clients ?? nonceClients();
  const quorum = options.quorum ?? 2;
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > clients.length) {
    throw new Error('invalid BSC nonce quorum policy');
  }
  const heads = (await Promise.allSettled(clients.map((client) => client.getBlockNumber())))
    .flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (heads.length < quorum) throw new Error('BSC nonce quorum unavailable');
  const blockNumber = heads[Math.floor(heads.length / 2)]!;
  const values = (await Promise.allSettled(clients.map((client) => client.readContract({
    address: account,
    abi: ACCOUNT_NONCE_ABI,
    functionName: 'getNonce',
    args: [seqKey],
    blockNumber,
  }))))
    .flatMap((result) => result.status === 'fulfilled' && typeof result.value === 'bigint'
      ? [result.value]
      : []);
  const counts = new Map<string, { value: bigint; count: number }>();
  for (const value of values) {
    const key = value.toString();
    const group = counts.get(key) ?? { value, count: 0 };
    group.count += 1;
    counts.set(key, group);
    if (group.count >= quorum) return group.value;
  }
  throw new Error('BSC nonce quorum mismatch');
}

/** Stable comparison of the inclusion and every log the funding proof reads. */
export function fundingReceiptFingerprint(receipt: TransactionReceipt): string {
  return JSON.stringify({
    blockHash: receipt.blockHash.toLowerCase(),
    blockNumber: receipt.blockNumber.toString(),
    transactionHash: receipt.transactionHash.toLowerCase(),
    status: receipt.status,
    logs: receipt.logs.map((log) => ({
      address: log.address.toLowerCase(),
      data: log.data.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      logIndex: log.logIndex,
    })),
  });
}

/**
 * The relay can confirm before every public RPC exposes the receipt, and one
 * configured provider may reject receipt history altogether. Poll all pinned
 * BSC endpoints and accept only a byte-matching quorum so neither an outage nor
 * one dishonest response decides whether the user's funding batch succeeded.
 */
export async function waitForBscTransactionReceipt(
  hash: Hex,
  options: {
    clients?: readonly BscReceiptClient[];
    quorum?: number;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<TransactionReceipt> {
  const clients = options.clients ?? receiptClients();
  const quorum = options.quorum ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  if (
    !Number.isSafeInteger(quorum)
    || quorum < 1
    || quorum > clients.length
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 0
    || !Number.isSafeInteger(pollMs)
    || pollMs < 0
  ) {
    throw new Error('invalid BSC receipt polling policy');
  }

  const deadline = Date.now() + timeoutMs;
  do {
    const responses = await Promise.all(clients.map(async (client) => {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch {
        return null;
      }
    }));
    const matching = new Map<string, TransactionReceipt[]>();
    for (const receipt of responses) {
      let fingerprint: string;
      try {
        if (!receipt || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) continue;
        fingerprint = fundingReceiptFingerprint(receipt);
      } catch {
        // viem formats known fields but does not runtime-validate the full RPC
        // shape. One malformed provider response must not suppress an honest
        // quorum from the other endpoints.
        continue;
      }
      const group = matching.get(fingerprint) ?? [];
      group.push(receipt);
      matching.set(fingerprint, group);
      if (group.length >= quorum) return group[0]!;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  } while (Date.now() <= deadline);

  throw new Error(
    'The relay confirmed the funding transaction, but two BSC RPC providers have not agreed on its receipt yet. Retry activation; do not deposit again.',
  );
}
