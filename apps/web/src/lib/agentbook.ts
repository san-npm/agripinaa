import 'server-only';

import { cacheLife } from 'next/cache';
import { createPublicClient, http, parseAbi, toHex } from 'viem';
import { base, worldchain } from 'viem/chains';

/**
 * World's AgentBook: a registry that maps an agent wallet to an anonymous
 * human identifier, written by a World ID proof. A wallet found here is
 * automation a verified human vouched for, which is a different claim from
 * "verified by Agripinaa" (execution evidence) and from "registered under
 * ERC-8004" (anyone can), so it gets its own badge and its own provenance.
 *
 * Two deployments are consulted because the toolkit is not consistent about
 * which one is canonical: the server-side verifier reads World Chain, while
 * the registration CLI writes to Base by default. Addresses from
 * github.com/worldcoin/agentkit (core/src/agent-book.ts, cli/REGISTRATION.md),
 * read 2026-09-12.
 */
const AGENT_BOOKS = [
  { registry: 'world-chain', chain: worldchain, address: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA' },
  { registry: 'base', chain: base, address: '0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4' },
] as const;

const ABI = parseAbi(['function lookupHuman(address agent) view returns (uint256)']);

/**
 * Enrichment only, so it gets one short attempt per registry and no retries:
 * a profile must render, and prerender, inside its cache-fill deadline even
 * when both public RPCs are stalled.
 */
const clients = AGENT_BOOKS.map((book) =>
  createPublicClient({ chain: book.chain, transport: http(undefined, { timeout: 3_000, retryCount: 0 }) }),
);

export interface HumanBacking {
  /** Anonymous human identifier from AgentBook, hex. Not a person, a nullifier. */
  humanId: string;
  registry: (typeof AGENT_BOOKS)[number]['registry'];
  asOf: string;
}

/**
 * Whether a wallet is registered in AgentBook, and where. Null means no
 * registration was found on either deployment or neither could be read: the
 * badge is a positive claim only, and its absence says nothing. The lookup
 * says something about the address it was given, nothing about who controls
 * it; the caller decides whether the address is one it can vouch for.
 */
export async function getHumanBacking(address: string | null): Promise<HumanBacking | null> {
  'use cache';
  cacheLife('hours');
  if (!address) return null;
  const answers = await Promise.all(
    AGENT_BOOKS.map(async (book, i) => {
      try {
        const humanId = await clients[i]!.readContract({
          address: book.address,
          abi: ABI,
          functionName: 'lookupHuman',
          args: [address as `0x${string}`],
        });
        return humanId === 0n ? null : { humanId: toHex(humanId), registry: book.registry };
      } catch {
        // An unreadable registry is not a negative answer.
        return null;
      }
    }),
  );
  const hit = answers.find((a) => a !== null);
  return hit ? { ...hit, asOf: new Date().toISOString() } : null;
}
