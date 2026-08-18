'use client';

import { BNB, BNB_TESTNET, createClient } from '@altananetwork/sdk';

/**
 * One Altana client for both chains; every operation selects its chain
 * explicitly by chainId (56 mainnet, 97 testnet).
 */
let client: ReturnType<typeof createClient> | null = null;

export function altanaClient() {
  client ??= createClient({ chains: [BNB, BNB_TESTNET], defaultChainId: 56 });
  return client;
}

export const SUPPORTED_CHAINS = [
  { id: 56, label: 'BNB Smart Chain', gasHint: 'needs ~0.002 BNB for key registration' },
  { id: 97, label: 'BSC Testnet', gasHint: 'free tBNB from the faucet works' },
] as const;
