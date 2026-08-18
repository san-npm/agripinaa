'use client';

import { deserializeSession, serializeSession } from '@agripinaa/session-kit';

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
    return JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as StoredSessionMeta[];
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

export function storeSession(input: {
  session: unknown;
  chainId: number;
  agent: StoredSessionMeta['agent'];
  scope: StoredSessionMeta['scope'];
}): StoredSessionMeta {
  const raw = serializeSession(input.session);
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
