import 'server-only';

import { BSC_MAINNET, ERC8004_REGISTRIES } from '@agripinaa/shared';
import { cacheLife } from 'next/cache';
import { createPublicClient, fallback, http, parseAbi } from 'viem';

import { bsc } from './bsc-chain';
import { VERIFIED_AGENTS } from './verified';

const REP_ABI = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
]);

const client = createPublicClient({
  chain: bsc,
  transport: fallback(BSC_MAINNET.rpcUrls.map((u) => http(u))),
});

export interface OnchainAttestation {
  count: number;
  value: number;
}

/**
 * Read our ERC-8004 attestation straight from the ReputationRegistry for a
 * verified agent. This is the provable source, independent of any indexer's
 * freshness. Returns null for non-verified agents (we can't cheaply
 * enumerate arbitrary agents' feedback on-chain).
 */
export async function getOnchainAttestation(
  tokenId: string,
): Promise<OnchainAttestation | null> {
  'use cache';
  cacheLife('hours');
  const verified = VERIFIED_AGENTS[tokenId];
  if (!verified) return null;
  try {
    const [count, value] = await client.readContract({
      address: ERC8004_REGISTRIES[56]!.reputation,
      abi: REP_ABI,
      functionName: 'getSummary',
      args: [
        BigInt(tokenId),
        [verified.attestation.verifier as `0x${string}`],
        'agripinaa-verified',
        '',
      ],
    });
    return { count: Number(count), value: Number(value) };
  } catch {
    return null;
  }
}
