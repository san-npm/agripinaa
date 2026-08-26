import { BSC_MAINNET } from '@agripinaa/shared';
import { createPublicClient, http, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `bigint:${item.toString()}` : item,
  );
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

async function fulfilled<T>(calls: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(calls);
  const values: T[] = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') values.push(item.value as T);
  }
  if (values.length < 2) throw new Error('RPC quorum unavailable: fewer than two backends answered');
  return values;
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
    const blockNumber = await commonBlock();
    const values = await fulfilled(
      clients.map((client) => client.readContract({ ...args[0], blockNumber } as never)),
    );
    return selectQuorumValue(values);
  };

  const simulateContract = async (...args: Parameters<typeof primary.simulateContract>) => {
    const blockNumber = await commonBlock();
    const simulations = await fulfilled(
      clients.map((client) => client.simulateContract({ ...args[0], blockNumber } as never)),
    );
    const agreedResult = selectQuorumValue(simulations.map((simulation) => simulation.result));
    return simulations.find((simulation) => canonical(simulation.result) === canonical(agreedResult))!;
  };

  const getBlock = async (...args: Parameters<typeof primary.getBlock>) => {
    const requested = args[0] ?? {};
    const blockNumber = requested.blockNumber ?? await commonBlock();
    const blocks = await fulfilled(
      clients.map((client) => client.getBlock({ ...requested, blockNumber } as never)),
    );
    return selectQuorumValue(blocks);
  };

  const waitForTransactionReceipt = async (
    ...args: Parameters<typeof primary.waitForTransactionReceipt>
  ) => {
    const receipts = await fulfilled(
      clients.map((client) => client.waitForTransactionReceipt(args[0] as never)),
    );
    const fingerprint = receipts.map((receipt) => ({
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      status: receipt.status,
    }));
    const agreed = selectQuorumValue(fingerprint);
    return receipts.find(
      (receipt) =>
        receipt.transactionHash === agreed.transactionHash &&
        receipt.blockHash === agreed.blockHash &&
        receipt.status === agreed.status,
    )!;
  };

  const getGasPrice = async () =>
    selectQuorumValue(await fulfilled(clients.map((client) => client.getGasPrice())));

  const overrides = new Map<PropertyKey, unknown>([
    ['readContract', readContract],
    ['simulateContract', simulateContract],
    ['getBlock', getBlock],
    ['getGasPrice', getGasPrice],
    ['waitForTransactionReceipt', waitForTransactionReceipt],
  ]);
  return new Proxy(primary, {
    get(target, property) {
      if (overrides.has(property)) return overrides.get(property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PublicClient;
}
