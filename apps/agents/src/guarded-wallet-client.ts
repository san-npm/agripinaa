import {
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { bsc } from 'viem/chains';

import { BSC_MAINNET } from '@agripinaa/shared';

const DEFAULT_GAS_LIMIT = 2_000_000n;
const DEFAULT_MAX_TX_FEE_WEI = 10_000_000_000_000_000n; // 0.01 BNB

function positiveEnv(name: string, fallbackValue: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined) return fallbackValue;
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${name} must be a positive base-unit integer`);
  }
  return BigInt(raw);
}

export function boundedLegacyFees(input: {
  requestedGas?: bigint;
  gasPrice: bigint;
  gasLimit?: bigint;
  maxTxFeeWei?: bigint;
}): { gas: bigint; gasPrice: bigint } {
  const ceiling = input.gasLimit ?? DEFAULT_GAS_LIMIT;
  const gas = input.requestedGas ?? ceiling;
  const maxTxFeeWei = input.maxTxFeeWei ?? DEFAULT_MAX_TX_FEE_WEI;
  if (gas <= 0n || gas > ceiling) {
    throw new Error(`transaction gas ${gas} exceeds agent limit ${ceiling}`);
  }
  if (input.gasPrice <= 0n || input.gasPrice * gas > maxTxFeeWei) {
    throw new Error(
      `transaction fee ceiling exceeded: gas=${gas}, gasPrice=${input.gasPrice}, maxWei=${maxTxFeeWei}`,
    );
  }
  return { gas, gasPrice: input.gasPrice };
}

/**
 * Local-account wallet whose writes never trust a provider-supplied gas
 * estimate. The limit is explicit and the legacy gas price comes from the
 * quorum public client; a hostile backend can delay a write, but cannot make
 * the signer authorize an unbounded fee.
 */
export function createGuardedWalletClient(
  account: Account,
  publicClient: PublicClient,
): WalletClient {
  const transport = fallback(BSC_MAINNET.rpcUrls.map((url) => http(url)));
  const client = createWalletClient({ account, chain: bsc, transport });
  const gasLimit = positiveEnv('AGENTS_MAX_GAS_LIMIT', DEFAULT_GAS_LIMIT);
  const maxTxFeeWei = positiveEnv('AGENTS_MAX_TX_FEE_WEI', DEFAULT_MAX_TX_FEE_WEI);

  const feeFields = async (requestedGas?: bigint) => boundedLegacyFees({
    requestedGas,
    gasPrice: await publicClient.getGasPrice(),
    gasLimit,
    maxTxFeeWei,
  });

  const writeContract = async (...args: Parameters<typeof client.writeContract>) => {
    const request = args[0];
    return client.writeContract({
      ...request,
      ...await feeFields(request.gas),
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    } as never);
  };
  const sendTransaction = async (...args: Parameters<typeof client.sendTransaction>) => {
    const request = args[0];
    return client.sendTransaction({
      ...request,
      ...await feeFields(request.gas),
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    } as never);
  };

  const overrides = new Map<PropertyKey, unknown>([
    ['writeContract', writeContract],
    ['sendTransaction', sendTransaction],
  ]);
  return new Proxy(client, {
    get(target, property) {
      if (overrides.has(property)) return overrides.get(property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WalletClient;
}
