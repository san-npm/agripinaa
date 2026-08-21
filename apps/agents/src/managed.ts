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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routerByAddress } from '@agripinaa/shared';
import { deserializeSession, serializeSession } from '@agripinaa/session-kit/persist';
import type { SessionPermissions } from '@altananetwork/sdk';
import type { Address, Hex } from 'viem';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

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

function file(agent: string): string {
  return join(DATA_DIR, `${agent}.managed.json`);
}

/** All accounts currently managed by `agent`. Missing file => none. */
export function loadManaged(agent: string): ManagedAccount[] {
  const f = file(agent);
  if (!existsSync(f)) return [];
  const parsed = deserializeSession(readFileSync(f, 'utf8')) as ManagedAccount[];
  return Array.isArray(parsed) ? parsed : [];
}

function save(agent: string, entries: ManagedAccount[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const f = file(agent);
  const tmp = `${f}.tmp`;
  // Atomic write: a crash mid-write must not truncate the registry.
  writeFileSync(tmp, serializeSession(entries), 'utf8');
  renameSync(tmp, f);
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
export function upsertManaged(agent: string, entry: ManagedAccount): ManagedAccount[] {
  const acct = entry.account.toLowerCase();
  const router = routerKey(entry);
  const rest = loadManaged(agent).filter(
    (e) => !(e.account.toLowerCase() === acct && routerKey(e) === router),
  );
  const next = [...rest, entry];
  save(agent, next);
  return next;
}

/** Remove a managed account (e.g. after the user revokes). No-op if absent. */
export function removeManaged(agent: string, account: Address): ManagedAccount[] {
  const key = account.toLowerCase();
  const next = loadManaged(agent).filter((e) => e.account.toLowerCase() !== key);
  save(agent, next);
  return next;
}
