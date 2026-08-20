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
  agent: { chainId: number; tokenId: string; name: string };
  scope: { allowlist: string[]; capFormatted: string; expiresAt: string };
  grantedAt: string;
  revokedAt: string | null;
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
}): StoredSessionMeta {
  const raw = serializeSession(stripSigner(input.session));
  const s = input.session as {
    publicKey?: string;
    walletAddress?: string;
  };
  const meta: StoredSessionMeta = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chainId: input.chainId,
    account: s.walletAddress ?? 'unknown',
    publicKey: s.publicKey ?? null,
    agent: input.agent,
    scope: input.scope,
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    raw,
  };
  write([...read(), meta]);
  return meta;
}

export function markRevoked(id: string): void {
  write(
    read().map((s) =>
      s.id === id ? { ...s, revokedAt: new Date().toISOString() } : s,
    ),
  );
}

export function forgetSession(id: string): void {
  write(read().filter((s) => s.id !== id));
}

export function reviveSession(meta: StoredSessionMeta): unknown {
  return deserializeSession(meta.raw);
}
