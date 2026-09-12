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
 * hooks do, with three things the hooks leave to the framework done here:
 * the nonce is consumed atomically before any async work, the signed URI must
 * be this exact resource (the library only compares hosts), and the Host the
 * challenge is bound to must be one this runner is actually published at.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  AGENTKIT,
  buildAgentkitSchema,
  createAgentBookVerifier,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  type AgentBookVerifier,
} from '@worldcoin/agentkit';

import { RequestGate } from './request-gate';

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
/** A nonce is remembered for the challenge TTL plus the library's issuedAt window. */
const NONCE_TTL_MS = CHALLENGE_TTL_MS + 5 * 60_000;
const NONCE_CAP = 10_000;

/**
 * Hosts a challenge may be bound to. The runner is published through a
 * Cloudflare quick tunnel; anything else reaching the listener directly can
 * set any Host it likes, and a signature for that Host must not count.
 * `AGENTKIT_PUBLIC_HOSTS` (comma separated) adds hosts for other setups.
 */
const EXTRA_PUBLIC_HOSTS = new Set(
  (process.env.AGENTKIT_PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
);
export function trustedHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return (
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h) ||
    /^[a-z0-9-]+\.trycloudflare\.com$/.test(h) ||
    EXTRA_PUBLIC_HOSTS.has(h)
  );
}

/** The public URL of this request, or null when its Host is not one we are published at. */
export function resourceUriFor(req: Pick<IncomingMessage, 'headers'>, pathname: string): string | null {
  const host = req.headers.host;
  if (!trustedHost(host)) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host!);
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

/**
 * Usage and nonce bookkeeping, in memory and bounded. Nonces expire with the
 * challenge and the map is capped, so a stranger sending fresh signatures
 * cannot grow the process; a runner restart resets the trial counters.
 * ponytail: swap for the agent state store if counters must survive restarts.
 */
export class BoundedAgentKitStorage {
  private readonly usage = new Map<string, number>();
  private readonly nonces = new Map<string, number>();

  constructor(
    private readonly nonceTtlMs = NONCE_TTL_MS,
    private readonly nonceCap = NONCE_CAP,
  ) {}

  /** Consume the nonce now, in one synchronous step: the second caller with it loses. */
  reserveNonce(nonce: string, now = Date.now()): boolean {
    const seen = this.nonces.get(nonce);
    if (seen !== undefined && seen > now) return false;
    if (this.nonces.size >= this.nonceCap) {
      for (const [n, expiresAt] of this.nonces) {
        if (expiresAt <= now) this.nonces.delete(n);
      }
      // Still full after sweeping expired ones: drop the oldest insertions.
      while (this.nonces.size >= this.nonceCap) {
        const oldest = this.nonces.keys().next().value;
        if (oldest === undefined) break;
        this.nonces.delete(oldest);
      }
    }
    this.nonces.set(nonce, now + this.nonceTtlMs);
    return true;
  }

  tryIncrementUsage(endpoint: string, humanId: string, limit: number): boolean {
    const key = `${endpoint}:${humanId}`;
    const count = this.usage.get(key) ?? 0;
    if (count >= limit) return false;
    this.usage.set(key, count + 1);
    return true;
  }
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
  storage?: BoundedAgentKitStorage;
  /** Admissions in flight at once and per client per minute; each costs a signature check and an RPC read. */
  gate?: RequestGate;
}

export type AgentkitGate = ReturnType<typeof createAgentkitGate>;

export function createAgentkitGate(opts: AgentkitGateOptions = {}) {
  const uses = opts.uses ?? FREE_TRIAL_USES;
  const storage = opts.storage ?? new BoundedAgentKitStorage();
  const gate = opts.gate ?? new RequestGate(30, 60_000, 4);
  const books = opts.agentBooks ?? [
    { name: 'world-chain', verifier: createAgentBookVerifier() },
    { name: 'base', verifier: createAgentBookVerifier({ contractAddress: BASE_AGENT_BOOK, rpcUrl: BASE_RPC_URL }) },
  ];
  const firstLine = (s: string | undefined, fallback: string) => (s ?? fallback).split('\n')[0]!;

  async function admitInner(header: string, resourceUri: string, path: string): Promise<Admission> {
    const payload = parseAgentkitHeader(header);
    // Consumed before anything awaits: a header captured in flight cannot be
    // presented twice, however close together the two arrive.
    if (!storage.reserveNonce(payload.nonce)) return { granted: false, reason: 'nonce already used (replay)' };
    const validation = await validateAgentkitMessage(payload, resourceUri);
    if (!validation.valid) return { granted: false, reason: firstLine(validation.error, 'invalid message') };
    // The library binds the host only. This runner serves several agents'
    // status on one host, so the signature must name this exact resource.
    if (payload.uri !== resourceUri) return { granted: false, reason: `URI mismatch: signed for ${payload.uri}` };
    const verification = await verifyAgentkitSignature(payload, { rpcUrls: opts.rpcUrls });
    if (!verification.valid || !verification.address) {
      return { granted: false, reason: firstLine(verification.error, 'invalid signature') };
    }
    for (const book of books) {
      const humanId = await book.verifier.lookupHuman(verification.address);
      if (!humanId) continue;
      if (storage.tryIncrementUsage(path, humanId, uses)) {
        return { granted: true, humanId, address: verification.address, registry: book.name };
      }
      return { granted: false, reason: `free trial of ${uses} used up for this human on ${path}`, humanId };
    }
    return { granted: false, reason: `${verification.address} is not registered in AgentBook` };
  }

  return {
    challenge: (resourceUri: string) => agentkitChallenge(resourceUri, uses),

    /**
     * Decide whether this request reads for free. Never throws: a malformed
     * header, a library error, or a refused permit is a declined admission,
     * and the caller falls through to the payment path.
     */
    async admit(
      header: string | undefined,
      resourceUri: string | null,
      path: string,
      clientKey = 'anonymous',
    ): Promise<Admission> {
      if (!header) return { granted: false, reason: 'no agentkit header' };
      if (!resourceUri) return { granted: false, reason: 'request Host is not a published runner host' };
      const permit = gate.enter(clientKey);
      if (!permit.ok) return { granted: false, reason: `too many verification attempts; retry in ${permit.retryAfterSeconds}s` };
      try {
        return await admitInner(header, resourceUri, path);
      } catch (err) {
        return { granted: false, reason: firstLine(err instanceof Error ? err.message : undefined, 'bad header') };
      } finally {
        permit.release();
      }
    },
  };
}
