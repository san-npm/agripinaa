import {
  BSC_MAINNET,
  BSC_TESTNET,
  ERC8004_REGISTRIES,
  IDENTITY_REGISTRY_ABI,
} from '@foyer/shared';
import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
} from 'viem';

import { classify } from '../classify';
import type { AgentDetail } from '../types';

const clients = new Map<number, PublicClient>();

function clientFor(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const rpcUrls =
    chainId === 97 ? BSC_TESTNET.rpcUrls : BSC_MAINNET.rpcUrls;
  const client = createPublicClient({
    transport: fallback(rpcUrls.map((u) => http(u))),
  });
  clients.set(chainId, client);
  return client;
}

function resolveUri(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  }
  return uri;
}

async function fetchMetadata(uri: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(resolveUri(uri), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    return typeof json === 'object' && json !== null
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Direct on-chain fallback: per-agent reads only (ownerOf + tokenURI +
 * metadata fetch). Deliberately no event-log enumeration: public BSC RPCs
 * throttle getLogs, and list views are served by 8004scan or the committed
 * snapshot instead.
 */
export async function readAgentFromRegistry(
  chainId: number,
  tokenId: string,
): Promise<AgentDetail | null> {
  const registries = ERC8004_REGISTRIES[chainId];
  if (!registries) return null;
  const client = clientFor(chainId);
  const asOf = new Date().toISOString();

  let owner: string;
  try {
    owner = await client.readContract({
      address: registries.identity,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    });
  } catch {
    return null; // nonexistent token
  }

  let agentURI: string | null = null;
  try {
    agentURI = await client.readContract({
      address: registries.identity,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'tokenURI',
      args: [BigInt(tokenId)],
    });
  } catch {
    agentURI = null;
  }

  const metadata = agentURI ? await fetchMetadata(agentURI) : null;
  const name =
    typeof metadata?.['name'] === 'string'
      ? (metadata['name'] as string)
      : `Agent #${tokenId}`;
  const description =
    typeof metadata?.['description'] === 'string'
      ? (metadata['description'] as string)
      : '';
  const image =
    typeof metadata?.['image'] === 'string' ? (metadata['image'] as string) : null;
  const agentWallet =
    typeof metadata?.['agentWallet'] === 'string'
      ? (metadata['agentWallet'] as string)
      : null;

  return {
    id: `${chainId}-${tokenId}`,
    chainId,
    tokenId,
    agentId: `${chainId}:${registries.identity.toLowerCase()}:${tokenId}`,
    name,
    description,
    imageUrl: image,
    owner,
    category: classify({ metadata, name, description }),
    supportedProtocols: [],
    x402Supported: false,
    registeredAt: null,
    trust: {
      totalScore: null,
      averageScore: null,
      rank: null,
      healthScore: null,
      totalFeedbacks: 0,
      starCount: null,
      isVerified: false,
      source: 'registry',
      asOf,
    },
    agentURI,
    agentWallet,
    metadata,
    services: null,
  };
}
