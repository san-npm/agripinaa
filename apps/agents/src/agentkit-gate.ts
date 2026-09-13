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
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const SIGNING_CHAINS = ['eip155:56', 'eip155:8453', 'eip155:480'] as const;
const STATEMENT =
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
/** Whole admission budget: parse, validate, verify (one eth_call at most), registry reads. */
const ADMIT_DEADLINE_MS = 8_000;

/**
 * Hosts a challenge may be bound to: this runner's own published hostname and
 * nothing else. Anything reaching the listener directly can set any Host it
 * likes, and a signature bound to a foreign host (another quick tunnel
 * included) must not count here. The runner learns its hostname the way the
 * operators do: `ops/tunnel-url.txt`, written by start-agents.sh and
 * report-runner-url.sh on every tunnel start, re-read on every admission.
 * `AGENTKIT_PUBLIC_HOSTS` (comma separated) adds fixed hosts for other setups.
 */
const EXTRA_PUBLIC_HOSTS = new Set(
  (process.env.AGENTKIT_PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
);
/** Resolved from this file, not the cwd: pnpm starts the runner inside apps/agents. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TUNNEL_URL_FILE = process.env.AGENTKIT_TUNNEL_URL_FILE ?? join(REPO_ROOT, 'ops', 'tunnel-url.txt');
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** The hostname in ops/tunnel-url.txt, re-read on every call: 60 bytes behind the rate limit. */
function publishedTunnelHost(): string | null {
  try {
    const url = new URL(readFileSync(TUNNEL_URL_FILE, 'utf8').trim());
    return url.protocol === 'https:' ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function trustedHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return LOCAL_HOST.test(h) || EXTRA_PUBLIC_HOSTS.has(h) || publishedTunnelHost() === h;
}

/**
 * The public URL of this request, or null when its Host is not one we are
 * published at or does not even form a URL (a port out of range, say).
 */
export function resourceUriFor(req: Pick<IncomingMessage, 'headers'>, pathname: string): string | null {
  const host = req.headers.host;
  if (!trustedHost(host)) return null;
  const local = LOCAL_HOST.test(host!);
  try {
    // Normalized (host lowercased) so the challenge, the signature and the
    // check all carry the same string; a Host that is not a URL is refused.
    return new URL(`${local ? 'http' : 'https'}://${host}${pathname}`).href;
  } catch {
    return null;
  }
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

  /**
   * Consume the nonce now, in one synchronous step: the second caller with it
   * loses. A store full of live nonces refuses rather than evicts, since an
   * evicted nonce would make a captured header good again; the rate limit in
   * front of this keeps the cap out of reach for anyone but an attacker.
   */
  reserveNonce(nonce: string, now = Date.now()): 'ok' | 'replay' | 'full' {
    const seen = this.nonces.get(nonce);
    if (seen !== undefined && seen > now) return 'replay';
    if (this.nonces.size >= this.nonceCap) {
      for (const [n, expiresAt] of this.nonces) {
        if (expiresAt <= now) this.nonces.delete(n);
      }
      if (this.nonces.size >= this.nonceCap) return 'full';
    }
    this.nonces.set(nonce, now + this.nonceTtlMs);
    return 'ok';
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
  /**
   * RPCs for ERC-1271 signature checks, keyed by CAIP-2 chain. EOAs need none
   * (viem recovers them offline). Every chain in SIGNING_CHAINS must be
   * reachable: the library ships public defaults for Base and World Chain
   * but none for BSC, so the server passes all three explicitly.
   */
  rpcUrls?: Record<string, string>;
  uses?: number;
  storage?: BoundedAgentKitStorage;
  /** Admissions in flight at once and per client per minute; each costs a signature check and an RPC read. */
  gate?: RequestGate;
  /** Whole admission budget; the default is ADMIT_DEADLINE_MS. */
  deadlineMs?: number;
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

  async function admitInner(
    header: string,
    resourceUri: string,
    path: string,
    expired: () => boolean,
  ): Promise<Admission> {
    const payload = parseAgentkitHeader(header);
    // Consumed before anything awaits: a header captured in flight cannot be
    // presented twice, however close together the two arrive.
    const reserved = storage.reserveNonce(payload.nonce);
    if (reserved === 'replay') return { granted: false, reason: 'nonce already used (replay)' };
    if (reserved === 'full') return { granted: false, reason: 'verification store is full; retry in a few minutes' };
    // Only the chains the challenge advertised: a client must not pick which
    // RPC this runner talks to by naming a chain of its own.
    if (!(SIGNING_CHAINS as readonly string[]).includes(payload.chainId)) {
      return { granted: false, reason: `chain ${payload.chainId} is not one the challenge offered` };
    }
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
      // The library's verifier answers null on an RPC failure; a custom one
      // may throw. Either way an unreadable registry is "not found here" and
      // the next registry is asked, so payment stays usable during an outage.
      let humanId: string | null;
      try {
        humanId = await book.verifier.lookupHuman(verification.address);
      } catch {
        humanId = null;
      }
      if (!humanId) continue;
      // The caller already got "took too long": the registry read that
      // finished late must not spend one of this human's free reads.
      if (expired()) return { granted: false, reason: 'verification took too long' };
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
      // Past the deadline the caller pays like everyone else, but the slot
      // stays taken until the late verification settles: releasing it early
      // would let a stalled registry admit unbounded concurrent lookups.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      const timeout = new Promise<Admission>((resolve) => {
        deadline = setTimeout(() => {
          expired = true;
          resolve({ granted: false, reason: 'verification took too long' });
        }, opts.deadlineMs ?? ADMIT_DEADLINE_MS);
      });
      const verification = admitInner(header, resourceUri, path, () => expired)
        .catch((err: unknown): Admission => ({
          granted: false,
          reason: firstLine(err instanceof Error ? err.message : undefined, 'bad header'),
        }))
        .finally(() => {
          clearTimeout(deadline);
          permit.release();
        });
      return Promise.race([verification, timeout]);
    },
  };
}
