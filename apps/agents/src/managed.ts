/**
 * Registry of user accounts an agent manages on the user's behalf.
 *
 * When a user activates managed mode, the browser grants a session scoped to
 * the YieldRouter selectors and posts {account, session} here. The agent
 * stores it and, each tick, acts on every managed account within its granted
 * scope. The session's private key is NOT stored here: the agent holds the
 * manager key separately (wallets/agent-<name>-session.json) and reconstructs
 * the signer at execute time. What we persist is only the public half needed
 * to rebuild the Session object: walletAddress, publicKey, permissions, expiry.
 *
 * Sessions require byte-exact persistence (the relay validates against the
 * exact granted object), so bigint spend limits round-trip through
 * session-kit's serialize/deserialize, never plain JSON.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { routerByAddress } from '@agripinaa/shared';
import { deserializeSession, serializeSession } from '@agripinaa/session-kit/persist';
import type { SessionPermissions } from '@altananetwork/sdk';
import type { Address, Hex } from 'viem';

import { DATA_DIR, ensureDataDir, writeStateFile } from './chassis';

/** The public, storable half of an SDK Session (no signer). */
export interface StoredSession {
  walletAddress: Address;
  publicKey: Hex;
  permissions: SessionPermissions;
  expiry: number;
}

export interface ManagedAccount {
  /** The user's smart-account address (== session.walletAddress). */
  account: Address;
  /** Chain the session was granted on (56 mainnet, 97 testnet). */
  chainId: number;
  session: StoredSession;
  registeredAt: string;
}

export interface ManagedHealth {
  at: number;
  result: 'ready' | 'error';
  reason?: string;
  /** Terminal writes stay unhealthy until a later write proves recovery. */
  requiresExecutionRecovery?: boolean;
}

/** A five-minute runner cadence gets three missed sweeps before status is stale. */
export const MANAGED_HEALTH_MAX_AGE_MS = 20 * 60 * 1000;
/** Hard admission ceiling so a public registration endpoint cannot grow sweep work without bound. */
export const MAX_MANAGED_ENTRIES_PER_AGENT = 300;

export function managedHealthKey(account: Address, router: Address): string {
  return `managed-health:${account.toLowerCase()}:${router.toLowerCase()}`;
}

/** Durable state owned by one public mandate, isolated from demo-wallet state. */
export function managedAccountStateKey(account: Address, key: string): string {
  return `managed:${account.toLowerCase()}:${key}`;
}

function file(agent: string, dir: string): string {
  return join(dir, `${agent}.managed.json`);
}

/**
 * All accounts currently managed by `agent`. Missing file => none. `dir`
 * defaults to the chassis data dir; tests point it at a scratch dir.
 */
export function loadManaged(agent: string, dir: string = DATA_DIR): ManagedAccount[] {
  const f = file(agent, dir);
  if (!existsSync(f)) return [];
  const parsed = deserializeSession(readFileSync(f, 'utf8')) as ManagedAccount[];
  return Array.isArray(parsed) ? parsed : [];
}

function save(agent: string, entries: ManagedAccount[], dir: string): void {
  // Owner-only dir and file: this holds every managed user's account, session
  // public key, granted permissions and expiry. Atomic through the chassis
  // temp+rename path, so a crash mid-write cannot truncate the registry.
  ensureDataDir(dir);
  writeStateFile(file(agent, dir), serializeSession(entries));
}

/**
 * The router (scoped call target) an entry manages through — its identity key.
 * Resolves to the KNOWN router address when the target is one of ours (so the
 * key is normalized), and guards every field access so a corrupt/foreign entry
 * can never throw here. Returns '' only when there is no usable target, which
 * can't collide across accounts (upsert also matches on the account).
 */
function routerKey(entry: ManagedAccount): string {
  const rawCalls = entry?.session?.permissions?.calls;
  const calls = Array.isArray(rawCalls) ? rawCalls : [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const to = 'to' in call ? (call as { to?: unknown }).to : undefined;
    if (typeof to === 'string' && to) {
      return (routerByAddress(to)?.address ?? to).toLowerCase();
    }
  }
  return '';
}

/**
 * Add or replace a managed account, keyed by (account, router). Keying by the
 * router as well as the account lets ONE account hold both a USDT and a USDC
 * mandate at once, and stops a re-registration for a different token from
 * silently overwriting the other token's mandate. A re-grant for the SAME
 * (account, router) still supersedes the old one.
 */
export function upsertManaged(
  agent: string,
  entry: ManagedAccount,
  dir: string = DATA_DIR,
): ManagedAccount[] {
  const current = loadManaged(agent, dir);
  const acct = entry.account.toLowerCase();
  const router = routerKey(entry);
  const replacesExisting = current.some(
    (candidate) => candidate.account.toLowerCase() === acct && routerKey(candidate) === router,
  );
  if (!replacesExisting && current.length >= MAX_MANAGED_ENTRIES_PER_AGENT) {
    throw new Error(`managed registry is full (${MAX_MANAGED_ENTRIES_PER_AGENT} mandates)`);
  }
  const rest = current.filter(
    (e) => !(e.account.toLowerCase() === acct && routerKey(e) === router),
  );
  const next = [...rest, entry];
  save(agent, next, dir);
  return next;
}

/** Remove a managed account (e.g. after the user revokes). No-op if absent. */
export function removeManaged(
  agent: string,
  account: Address,
  dir: string = DATA_DIR,
): ManagedAccount[] {
  const key = account.toLowerCase();
  const next = loadManaged(agent, dir).filter((e) => e.account.toLowerCase() !== key);
  save(agent, next, dir);
  return next;
}

/** Remove one token/router mandate without deleting the account's other token. */
export function removeManagedEntry(
  agent: string,
  entry: ManagedAccount,
  dir: string = DATA_DIR,
): ManagedAccount[] {
  const account = entry.account.toLowerCase();
  const router = routerKey(entry);
  const next = loadManaged(agent, dir).filter(
    (candidate) => !(candidate.account.toLowerCase() === account && routerKey(candidate) === router),
  );
  save(agent, next, dir);
  return next;
}
