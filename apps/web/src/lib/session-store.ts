'use client';

import { deserializeSession, serializeSession } from '@agripinaa/session-kit/codec';

/**
 * Local registry of sessions this browser has granted. The session payload is
 * stored as the EXACT serialized string produced at grant time (re-serializing
 * a parsed session can change byte order and break execution upstream).
 */
export interface StoredSessionMeta {
  id: string;
  chainId: number;
  account: string;
  publicKey: string | null;
  agent: { chainId: number; tokenId: string; name: string; slug?: string };
  scope: { allowlist: string[]; capFormatted: string; expiresAt: string };
  grantedAt: string;
  /** Latest activation attempt this grant was correlated with. */
  correlatedAt?: string;
  revokedAt: string | null;
  /** Whether the runner acknowledged this locally recoverable session. */
  registrationStatus?: 'pending' | 'registered';
  /** Managed only: whole token balance observed at activation, for earnings math. */
  principalUsdt?: string;
  /** Byte-exact serialized session. */
  raw: string;
}

const KEY = 'agripinaa.sessions.v1';

function read(): StoredSessionMeta[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(KEY) ?? '[]',
    ) as StoredSessionMeta[];
    // Retroactively scrub any signer/_privateKey left by older builds that
    // serialized the full session; rewrite storage if anything changed.
    let mutated = false;
    const scrubbed = stored.map((meta) => {
      if (meta.raw && meta.raw.includes('_privateKey')) {
        mutated = true;
        try {
          const parsed = JSON.parse(meta.raw) as Record<string, unknown>;
          delete parsed['signer'];
          return { ...meta, raw: JSON.stringify(parsed) };
        } catch {
          return { ...meta, raw: '' };
        }
      }
      return meta;
    });
    if (mutated) window.localStorage.setItem(KEY, JSON.stringify(scrubbed));
    return scrubbed;
  } catch {
    return [];
  }
}

function write(sessions: StoredSessionMeta[]): void {
  window.localStorage.setItem(KEY, JSON.stringify(sessions));
}

export function listStoredSessions(): StoredSessionMeta[] {
  return read().sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}

/**
 * The Altana SDK embeds the freshly generated session signer, including its
 * raw `_privateKey`, on the returned session object. That key must NEVER be
 * persisted: it has on-chain authority to spend within the session scope,
 * and nothing here needs it (revoke reads only publicKey; the agent process
 * signs from its own on-disk session file). Strip the signer before storing.
 */
function stripSigner(session: unknown): unknown {
  if (typeof session !== 'object' || session === null) return session;
  const { signer: _signer, ...rest } = session as Record<string, unknown>;
  void _signer;
  return rest;
}

export function storeSession(input: {
  session: unknown;
  chainId: number;
  agent: StoredSessionMeta['agent'];
  scope: StoredSessionMeta['scope'];
  principalUsdt?: string;
}): StoredSessionMeta {
  const raw = serializeSession(stripSigner(input.session));
  const s = input.session as {
    publicKey?: string;
    walletAddress?: string;
  };
  const sessions = read();
  const sameGrant = (candidate: StoredSessionMeta) =>
    s.walletAddress !== undefined
    && s.publicKey !== undefined
    && candidate.revokedAt === null
    && candidate.chainId === input.chainId
    && candidate.account.toLowerCase() === (s.walletAddress ?? 'unknown').toLowerCase()
    && candidate.publicKey?.toLowerCase() === s.publicKey?.toLowerCase()
    && (
      input.agent.slug !== undefined
        ? candidate.agent.slug === input.agent.slug
        : candidate.agent.chainId === input.agent.chainId
          && candidate.agent.tokenId === input.agent.tokenId
    );
  // A confirmed grant may already have been persisted before the runner
  // handoff failed. Recovery rebuilds the public session from exact on-chain
  // state, then refreshes that record instead of leaving two dashboard cards
  // whose revoke buttons target the same irreversible key registration.
  const existing = sessions.find((candidate) => sameGrant(candidate)
    && candidate.registrationStatus === 'registered')
    ?? sessions.find(sameGrant);
  const correlatedAt = new Date().toISOString();
  const meta: StoredSessionMeta = {
    id: existing?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chainId: input.chainId,
    account: s.walletAddress ?? 'unknown',
    publicKey: s.publicKey ?? null,
    agent: input.agent,
    scope: input.scope,
    grantedAt: existing?.grantedAt ?? correlatedAt,
    correlatedAt,
    revokedAt: null,
    registrationStatus: existing?.registrationStatus ?? 'pending',
    principalUsdt: existing?.principalUsdt ?? input.principalUsdt,
    raw,
  };
  write([...sessions.filter((candidate) => !sameGrant(candidate)), meta]);
  return meta;
}

export function markRevoked(id: string): void {
  write(
    read().map((s) =>
      s.id === id ? { ...s, revokedAt: new Date().toISOString() } : s,
    ),
  );
}

export function markRegistered(id: string): void {
  write(read().map((s) => (s.id === id ? { ...s, registrationStatus: 'registered' } : s)));
}

export function forgetSession(id: string): void {
  write(read().filter((s) => s.id !== id));
}

export function reviveSession(meta: StoredSessionMeta): unknown {
  return deserializeSession(meta.raw);
}
