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
 * read 2026-09-12. Enrichment only, so each registry gets one short attempt
 * and no retries: a profile must render, and prerender, inside its cache-fill
 * deadline even when both public RPCs are stalled.
 */
const AGENT_BOOKS = (
  [
    { registry: 'world-chain', chain: worldchain, address: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA' },
    { registry: 'base', chain: base, address: '0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4' },
  ] as const
).map((book) => ({
  ...book,
  client: createPublicClient({ chain: book.chain, transport: http(undefined, { timeout: 3_000, retryCount: 0 }) }),
}));

const ABI = parseAbi(['function lookupHuman(address agent) view returns (uint256)']);

export type Registry = 'world-chain' | 'base';

export interface HumanBacking {
  status: 'registered';
  /** Anonymous human identifier from AgentBook, hex. Not a person, a nullifier. */
  humanId: string;
  registry: Registry;
  asOf: string;
}

/**
 * Three answers, kept apart: registered somewhere; absent from every registry
 * that answered; or no registry answered at all. The last one must never be
 * shown as an absence, and it is what a transient RPC outage produces.
 */
export type HumanBackingResult =
  | HumanBacking
  | { status: 'absent'; asOf: string }
  | { status: 'unavailable'; asOf: string };

export type RegistryAnswer =
  | { status: 'registered'; humanId: string; registry: Registry }
  | { status: 'absent' }
  | { status: 'unavailable' };

/** One answer from many registries: any registration wins, one absence beats an outage. */
export function foldAgentBook(answers: RegistryAnswer[], asOf: string): HumanBackingResult {
  const hit = answers.find((a): a is Extract<RegistryAnswer, { status: 'registered' }> => a.status === 'registered');
  if (hit) return { ...hit, asOf };
  return answers.some((a) => a.status === 'absent') ? { status: 'absent', asOf } : { status: 'unavailable', asOf };
}

/**
 * Whether a wallet is registered in AgentBook, and where. The lookup says
 * something about the address it was given, nothing about who controls it;
 * the caller decides whether the address is one it can vouch for. Cached for
 * minutes rather than hours so an outage answer does not outlive the outage.
 */
export async function getHumanBacking(address: string | null): Promise<HumanBackingResult | null> {
  'use cache';
  cacheLife('minutes');
  if (!address) return null;
  const answers = await Promise.all(
    AGENT_BOOKS.map(async (book): Promise<RegistryAnswer> => {
      try {
        const humanId = await book.client.readContract({
          address: book.address,
          abi: ABI,
          functionName: 'lookupHuman',
          args: [address as `0x${string}`],
        });
        return humanId === 0n ? { status: 'absent' } : { status: 'registered', humanId: toHex(humanId), registry: book.registry };
      } catch {
        return { status: 'unavailable' };
      }
    }),
  );
  return foldAgentBook(answers, new Date().toISOString());
}
