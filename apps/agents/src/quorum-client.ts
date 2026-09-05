import { BSC_MAINNET } from '@agripinaa/shared';
import { createPublicClient, http, type Block, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return `bigint:${item.toString()}`;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/** Return the value supported by at least `required` independent backends. */
export function selectQuorumValue<T>(values: readonly T[], required = 2): T {
  const groups = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = canonical(value);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { value, count: 1 });
  }
  const winner = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  if (!winner || winner.count < required) {
    throw new Error(`RPC quorum mismatch: ${values.length} responses, none supported by ${required}`);
  }
  return winner.value;
}

/**
 * Gas price is an estimate, not chain state: honest providers routinely return
 * different recommendations. With three answers, use the numeric median so
 * one outlier cannot set the fee. With only two, accept the conservative
 * estimate only when both answers are within a bounded spread; otherwise no
 * independent estimate exists and the write fails closed.
 */
export function selectGasPrice(values: readonly bigint[]): bigint {
  if (values.length < 2) {
    throw new Error('RPC quorum unavailable: fewer than two gas-price estimates');
  }
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.some((value) => value <= 0n)) {
    throw new Error('RPC quorum mismatch: invalid gas-price estimate');
  }
  if (sorted.length === 2) {
    const low = sorted[0]!;
    const high = sorted[1]!;
    // A two-provider result has no majority. Permit ordinary estimator drift,
    // but bound either backend's influence to 20% of the other estimate.
    if (high * 10_000n > low * 12_000n) {
      throw new Error('RPC quorum mismatch: gas-price estimates exceed 20% spread');
    }
    return high;
  }
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function fulfilled<T>(calls: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(calls);
  const values: T[] = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') values.push(item.value as T);
  }
  if (values.length < 2) throw new Error('RPC quorum unavailable: fewer than two backends answered');
  return values;
}

export function transactionReceiptFingerprint(receipt: {
  transactionHash: unknown;
  blockHash: unknown;
  blockNumber?: unknown;
  status: unknown;
  logs?: readonly { address: unknown; topics: unknown; data: unknown; logIndex?: unknown }[];
}) {
  return {
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    logs: receipt.logs?.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: log.logIndex,
    })) ?? [],
  };
}

export function blockFingerprint({ size: _size, ...block }: Block) {
  // BSC providers report different serialized sizes for the same block.
  // Size is node metadata; retain agreement on every chain-state field.
  return block;
}

/**
 * Public client for unattended financial decisions. Every contract read and
 * simulation is pinned to one block and must match on two independent RPCs;
 * receipts likewise need two matching views. A single provider can therefore
 * make the agent pause, but cannot fabricate state that makes it trade.
 */
export function createQuorumPublicClient(
  urls: readonly string[] = BSC_MAINNET.rpcUrls,
): PublicClient {
  if (urls.length < 2) throw new Error('at least two RPC URLs are required for quorum');
  const clients = urls.map((url) => createPublicClient({ chain: bsc, transport: http(url) }));
  const primary = clients[0]!;

  const commonBlock = async (): Promise<bigint> => {
    const heads = (await fulfilled(clients.map((client) => client.getBlockNumber()))).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return heads[Math.floor(heads.length / 2)]!;
  };

  const readContract = async (...args: Parameters<typeof primary.readContract>) => {
    const blockNumber = args[0].blockNumber ?? await commonBlock();
    const values = await fulfilled(
      clients.map((client) => client.readContract({ ...args[0], blockNumber } as never)),
    );
    return selectQuorumValue(values);
  };

  const simulateContract = async (...args: Parameters<typeof primary.simulateContract>) => {
    const blockNumber = args[0].blockNumber ?? await commonBlock();
    const simulations = await fulfilled(
      clients.map((client) => client.simulateContract({ ...args[0], blockNumber } as never)),
    );
    const agreedResult = selectQuorumValue(simulations.map((simulation) => simulation.result));
    return simulations.find((simulation) => canonical(simulation.result) === canonical(agreedResult))!;
  };

  const getCode = async (...args: Parameters<typeof primary.getCode>) => {
    const blockNumber = args[0].blockNumber ?? await commonBlock();
    const values = await fulfilled(
      clients.map((client) => client.getCode({ ...args[0], blockNumber } as never)),
    );
    return selectQuorumValue(values);
  };

  const getBlock = async (...args: Parameters<typeof primary.getBlock>) => {
    const requested = args[0] ?? {};
    const blockNumber = requested.blockNumber ?? await commonBlock();
    const blocks = await fulfilled(
      clients.map((client) => client.getBlock({ ...requested, blockNumber } as never)),
    );
    const agreed = selectQuorumValue(blocks.map(blockFingerprint));
    return blocks.find((block) => canonical(blockFingerprint(block)) === canonical(agreed))!;
  };

  const waitForTransactionReceipt = async (
    ...args: Parameters<typeof primary.waitForTransactionReceipt>
  ) => {
    const receipts = await fulfilled(
      clients.map((client) => client.waitForTransactionReceipt(args[0] as never)),
    );
    const fingerprint = receipts.map(transactionReceiptFingerprint);
    const agreed = selectQuorumValue(fingerprint);
    return receipts.find(
      (receipt) =>
        canonical(transactionReceiptFingerprint(receipt)) === canonical(agreed),
    )!;
  };

  const getTransactionReceipt = async (
    ...args: Parameters<typeof primary.getTransactionReceipt>
  ) => {
    const receipts = await fulfilled(
      clients.map((client) => client.getTransactionReceipt(args[0])),
    );
    const agreed = selectQuorumValue(receipts.map(transactionReceiptFingerprint));
    return receipts.find(
      (receipt) => canonical(transactionReceiptFingerprint(receipt)) === canonical(agreed),
    )!;
  };

  const getGasPrice = async () =>
    selectGasPrice(await fulfilled(clients.map((client) => client.getGasPrice())));

  const overrides = new Map<PropertyKey, unknown>([
    ['readContract', readContract],
    ['simulateContract', simulateContract],
    ['getCode', getCode],
    ['getBlock', getBlock],
    ['getGasPrice', getGasPrice],
    ['waitForTransactionReceipt', waitForTransactionReceipt],
    ['getTransactionReceipt', getTransactionReceipt],
  ]);
  return new Proxy(primary, {
    get(target, property) {
      if (overrides.has(property)) return overrides.get(property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PublicClient;
}
