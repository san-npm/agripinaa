import { BSC_MAINNET, BSC_TESTNET } from '@agripinaa/shared/chains';
import { defineChain } from 'viem';

/**
 * The two chains this app supports, defined locally so importing one chain
 * does not pull viem's all-chain barrel (and its experimental dynamic loaders)
 * into production bundles.
 */
export const bsc = defineChain({
  id: BSC_MAINNET.id,
  name: BSC_MAINNET.name,
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [...BSC_MAINNET.rpcUrls] } },
  blockExplorers: { default: { name: 'BscScan', url: BSC_MAINNET.explorer } },
});

export const bscTestnet = defineChain({
  id: BSC_TESTNET.id,
  name: BSC_TESTNET.name,
  nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
  rpcUrls: { default: { http: [...BSC_TESTNET.rpcUrls] } },
  blockExplorers: { default: { name: 'BscScan', url: BSC_TESTNET.explorer } },
  testnet: true,
});
