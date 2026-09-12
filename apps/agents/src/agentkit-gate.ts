/**
 * World AgentKit at the x402 door.
 *
 * A caller that proves its wallet is registered in World's AgentBook (a
 * verified human vouched for it with a World ID proof) reads an agent's
 * status a few times without paying. Everyone else sees the same 402 as
 * before, now carrying the AgentKit challenge so an AgentKit-aware client
 * knows the free path exists.
 *
 * The x402 server here is raw `node:http`, not the Hono stack AgentKit's hooks
 * plug into, so this uses the library's low-level pieces in the same order the
 * hooks do: parse the header, validate the SIWE fields against the resource
 * URI, verify the signature, refuse a replayed nonce, look the wallet up in
 * AgentBook, then count the free use per human per endpoint.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  AGENTKIT,
  InMemoryAgentKitStorage,
  buildAgentkitSchema,
  createAgentBookVerifier,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  type AgentBookVerifier,
  type AgentKitStorage,
} from '@worldcoin/agentkit';
export const FREE_TRIAL_USES = 3;
/** Chains a caller may sign the challenge on. AgentBook lookup is chain-independent. */
export const SIGNING_CHAINS = ['eip155:56', 'eip155:8453', 'eip155:480'] as const;
export const STATEMENT =
  'Prove this agent acts for a real, World ID-verified human to read this Agripinaa agent status without paying.';
/**
 * AgentBook on Base. The verifier's default reads World Chain, the
 * registration CLI writes to Base by default (github.com/worldcoin/agentkit,
 * cli/REGISTRATION.md, 2026-09-12), so both are consulted.
 */
const BASE_AGENT_BOOK = '0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4' as const;
/**
 * viem's public Base RPC. Passed as `rpcUrl` rather than a viem client: the
 * verifier only ever issues eth_call, and the library's `client` option is
 * typed against its own copy of viem, which does not unify with ours.
 */
const BASE_RPC_URL = 'https://mainnet.base.org';
const CHALLENGE_TTL_MS = 5 * 60_000;

/** The public URL of this request, as the tunnel exposes it. */
export function resourceUriFor(req: Pick<IncomingMessage, 'headers'>, pathname: string): string {
  const host = req.headers.host ?? 'localhost';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${local ? 'http' : 'https'}://${host}${pathname}`;
}

/** The `extensions.agentkit` block of a 402: a fresh CAIP-122 challenge. */
export function agentkitChallenge(resourceUri: string, uses = FREE_TRIAL_USES) {
  const now = Date.now();
  return {
    [AGENTKIT]: {
      info: {
        // validateAgentkitMessage compares the domain to the hostname and the
        // uri's host (with port) to the resource's, so both are set from it.
        domain: new URL(resourceUri).hostname,
        uri: resourceUri,
        version: '1',
        nonce: randomBytes(16).toString('hex'),
        issuedAt: new Date(now).toISOString(),
        expirationTime: new Date(now + CHALLENGE_TTL_MS).toISOString(),
        statement: STATEMENT,
        resources: [resourceUri],
      },
      supportedChains: SIGNING_CHAINS.flatMap((chainId) =>
        (['eip191', 'eip1271'] as const).map((type) => ({ chainId, type })),
      ),
      schema: buildAgentkitSchema(),
      mode: { type: 'free-trial' as const, uses },
    },
  };
}

export type Admission =
  | { granted: true; humanId: string; address: string; registry: string }
  | { granted: false; reason: string; humanId?: string };

export interface AgentkitGateOptions {
  /** Registries to consult, in order. Defaults to World Chain then Base. */
  agentBooks?: { name: string; verifier: AgentBookVerifier }[];
  /** RPCs for ERC-1271 signature checks, keyed by CAIP-2 chain. EOAs need none. */
  rpcUrls?: Record<string, string>;
  uses?: number;
  /** ponytail: in-memory by default, so a runner restart resets the trial counters. */
  storage?: AgentKitStorage;
}

export type AgentkitGate = ReturnType<typeof createAgentkitGate>;

export function createAgentkitGate(opts: AgentkitGateOptions = {}) {
  const uses = opts.uses ?? FREE_TRIAL_USES;
  const storage = opts.storage ?? new InMemoryAgentKitStorage();
  const books = opts.agentBooks ?? [
    { name: 'world-chain', verifier: createAgentBookVerifier() },
    { name: 'base', verifier: createAgentBookVerifier({ contractAddress: BASE_AGENT_BOOK, rpcUrl: BASE_RPC_URL }) },
  ];
  const firstLine = (s: string | undefined, fallback: string) => (s ?? fallback).split('\n')[0]!;

  return {
    challenge: (resourceUri: string) => agentkitChallenge(resourceUri, uses),

    async admit(header: string | undefined, resourceUri: string, path: string): Promise<Admission> {
      if (!header) return { granted: false, reason: 'no agentkit header' };
      let payload: ReturnType<typeof parseAgentkitHeader>;
      try {
        payload = parseAgentkitHeader(header);
      } catch (err) {
        return { granted: false, reason: firstLine(err instanceof Error ? err.message : undefined, 'bad header') };
      }
      const validation = await validateAgentkitMessage(payload, resourceUri, {
        checkNonce: async (nonce) => !(await storage.hasUsedNonce?.(nonce)),
      });
      if (!validation.valid) return { granted: false, reason: firstLine(validation.error, 'invalid message') };
      const verification = await verifyAgentkitSignature(payload, { rpcUrls: opts.rpcUrls });
      if (!verification.valid || !verification.address) {
        return { granted: false, reason: firstLine(verification.error, 'invalid signature') };
      }
      await storage.recordNonce?.(payload.nonce);
      for (const book of books) {
        const humanId = await book.verifier.lookupHuman(verification.address);
        if (!humanId) continue;
        if (await storage.tryIncrementUsage(path, humanId, uses)) {
          return { granted: true, humanId, address: verification.address, registry: book.name };
        }
        return { granted: false, reason: `free trial of ${uses} used up for this human on ${path}`, humanId };
      }
      return { granted: false, reason: `${verification.address} is not registered in AgentBook` };
    },
  };
}
