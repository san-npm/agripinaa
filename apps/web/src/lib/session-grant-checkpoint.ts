'use client';

import type { Address, Hex } from 'viem';

const KEY_PREFIX = 'agripinaa.session-grant.v1';
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})+$/;
const PUBLIC_KEY_RE = /^0x04[0-9a-fA-F]{128}$/;
const RESERVE_PADDING = '0'.repeat(4 * 1024);

export type SessionGrantCheckpoint = {
  publicKey: Hex;
  expiry: number;
  savedAt: number;
} & (
  | { status: 'reserved' }
  | { status: 'submitted'; callsId: Hex }
);

interface StoredSessionGrantCheckpoint {
  version?: unknown;
  status?: unknown;
  publicKey?: unknown;
  expiry?: unknown;
  savedAt?: unknown;
  callsId?: unknown;
  reservePadding?: unknown;
}

function key(chainId: number, account: Address, agent: string): string {
  return `${KEY_PREFIX}:${chainId}:${account.toLowerCase()}:${encodeURIComponent(agent)}`;
}

/** Hold the account/agent grant transition across every tab in this browser. */
export async function acquireSessionGrantBrowserLock(
  chainId: number,
  account: Address,
  agent: string,
): Promise<() => Promise<void>> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot safely coordinate agent activation across tabs. Update it or close the other tabs and use a browser with Web Locks support.');
  }
  let releaseHold!: () => void;
  let acquiredResolve!: () => void;
  let acquiredReject!: (cause: unknown) => void;
  let released = false;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const request = navigator.locks.request(
    `agripinaa-session-grant:${chainId}:${account.toLowerCase()}:${encodeURIComponent(agent)}`,
    { mode: 'exclusive' },
    async () => {
      acquiredResolve();
      await hold;
    },
  );
  void request.catch(acquiredReject);
  await acquired;
  return async () => {
    if (!released) {
      released = true;
      releaseHold();
    }
    await request;
  };
}

/** Browser-wide lock plus a short server-side lease shared by all profiles/devices. */
export async function acquireSessionGrantSubmissionLock(
  chainId: number,
  account: Address,
  agent: string,
  publicKey: Hex,
  expiry: number,
): Promise<() => Promise<void>> {
  const releaseBrowser = await acquireSessionGrantBrowserLock(chainId, account, agent);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const leaseToken = `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const body = { account, agent, publicKey, expiry, leaseToken };
  try {
    const response = await fetch('/api/session/grant-lease', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(response.status === 409
        ? 'Another activation or previous manager binding is still active for this account and agent. Retry after the existing session expires.'
        : 'The shared activation lock is unavailable. Activation stopped before granting.');
    }
  } catch (cause) {
    await releaseBrowser();
    throw cause;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await fetch('/api/session/grant-lease', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } finally {
      await releaseBrowser();
    }
  };
}

function parseCheckpoint(value: unknown): SessionGrantCheckpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const stored = value as StoredSessionGrantCheckpoint;
  if (
    stored.version !== 1
    || (stored.status !== 'reserved' && stored.status !== 'submitted')
    || typeof stored.publicKey !== 'string'
    || !PUBLIC_KEY_RE.test(stored.publicKey)
    || typeof stored.expiry !== 'number'
    || !Number.isSafeInteger(stored.expiry)
    || stored.expiry <= 0
    || typeof stored.savedAt !== 'number'
    || !Number.isSafeInteger(stored.savedAt)
    || stored.savedAt <= 0
  ) return null;
  const base = {
    publicKey: stored.publicKey as Hex,
    expiry: stored.expiry,
    savedAt: stored.savedAt,
  };
  if (stored.status === 'reserved') return { ...base, status: 'reserved' };
  if (typeof stored.callsId !== 'string' || !HEX_RE.test(stored.callsId)) return null;
  return { ...base, status: 'submitted', callsId: stored.callsId as Hex };
}

export function loadSessionGrantCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
): SessionGrantCheckpoint | null {
  const storageKey = key(chainId, account, agent);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const checkpoint = parseCheckpoint(JSON.parse(raw));
    // Corrupt state cannot prove that no relay submission occurred. Preserve
    // it and fail closed at the caller instead of silently reopening a grant.
    if (!checkpoint) throw new Error('The saved session-grant checkpoint is unreadable.');
    return checkpoint;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('unreadable')) throw cause;
    throw new Error('This browser cannot read the saved session-grant checkpoint.');
  }
}

/**
 * Resolve the only safe automatic manager-rotation case.
 *
 * A reservation can mean that the relay accepted a request even when its id
 * never reached localStorage. Consequently a checkpoint for a different
 * manager cannot be discarded while that old grant could still become live.
 * Once its signed expiry has passed, however, the old key cannot overlap the
 * replacement key even if a delayed relay submission eventually lands.
 */
export function retireExpiredRotatedManagerCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
  currentPublicKey: Hex,
  nowSeconds = Math.floor(Date.now() / 1_000),
): SessionGrantCheckpoint | null {
  const checkpoint = loadSessionGrantCheckpoint(chainId, account, agent);
  if (
    checkpoint === null
    || checkpoint.publicKey.toLowerCase() === currentPublicKey.toLowerCase()
  ) return checkpoint;

  if (checkpoint.expiry > nowSeconds) {
    throw new Error(
      `A saved grant for the previous manager key may remain relayable until ${new Date(checkpoint.expiry * 1_000).toISOString()}. Activation will not authorize its replacement before then; retry after that expiry.`,
    );
  }

  const storageKey = key(chainId, account, agent);
  try {
    window.localStorage.removeItem(storageKey);
    if (window.localStorage.getItem(storageKey) !== null) {
      throw new Error('checkpoint remained present');
    }
  } catch {
    throw new Error('The expired grant for the previous manager key could not be retired from this browser. Activation stopped without submitting a new grant.');
  }
  return null;
}

/**
 * Reserve durable space only after the passkey signed, but before the relay is
 * contacted. If replacement with the relay id later fails, this marker still
 * blocks an unsafe duplicate grant.
 */
export function reserveSessionGrantCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
  publicKey: Hex,
  expiry: number,
): void {
  if (loadSessionGrantCheckpoint(chainId, account, agent)) {
    throw new Error('Another session-grant attempt is already reserved for this account and agent.');
  }
  window.localStorage.setItem(key(chainId, account, agent), JSON.stringify({
    version: 1,
    status: 'reserved',
    publicKey,
    expiry,
    savedAt: Date.now(),
    reservePadding: RESERVE_PADDING,
  }));
}

/** Atomically replace the pre-submit reservation with the relay call id. */
export function submitSessionGrantCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
  publicKey: Hex,
  expiry: number,
  callsId: Hex,
): void {
  const existing = loadSessionGrantCheckpoint(chainId, account, agent);
  if (
    existing?.status !== 'reserved'
    || existing.publicKey.toLowerCase() !== publicKey.toLowerCase()
    || existing.expiry !== expiry
  ) {
    throw new Error('The session-grant reservation changed before relay submission completed.');
  }
  window.localStorage.setItem(key(chainId, account, agent), JSON.stringify({
    version: 1,
    status: 'submitted',
    publicKey,
    expiry,
    savedAt: existing.savedAt,
    callsId,
  }));
}

export function clearSessionGrantCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
): void {
  try {
    window.localStorage.removeItem(key(chainId, account, agent));
  } catch {
    // A stored session remains visible and revocable even if cleanup is denied.
  }
}
