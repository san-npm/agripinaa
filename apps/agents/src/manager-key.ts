/**
 * The per-agent manager session key. This is the key users grant a scoped
 * session to; the agent signs router calls with it. It lives in its own wallet
 * file (wallets/agent-<name>-session.json) so it is distinct from the agent's
 * own-capital wallet and can be rotated without touching agent funds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { concat, keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WALLETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wallets');

export interface ManagerKey {
  privateKey: Hex;
  address: Hex;
  /** SEC1 uncompressed public key (0x04 || x || y) — what the browser grants to. */
  publicKey: Hex;
}

export function managerKeyFile(agent: string): string {
  return join(WALLETS_DIR, `agent-${agent}-session.json`);
}

/** Load the agent's master manager key, or null if it was never generated. */
export function loadManagerKey(agent: string): ManagerKey | null {
  const file = managerKeyFile(agent);
  if (!existsSync(file)) return null;
  const { privateKey } = JSON.parse(readFileSync(file, 'utf8')) as { privateKey: Hex };
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address, publicKey: account.publicKey };
}

/**
 * Derive a distinct manager key for one token from the agent's master key.
 * keccak256(masterPriv || tag) is a deterministic 32-byte scalar, so every
 * token gets its OWN on-chain key identity while the agent still stores a
 * single secret on disk. This is what stops a USDC grant from sharing the
 * USDT grant's on-chain expiry/revocation (Porto hashes a key by type+pubkey
 * only, so one shared key = one shared authorization lifecycle).
 *
 * The tag is `agripinaa-managed:<symbol>` and carries NO chain id, so the same
 * symbol derives the same key on every chain. That is a limitation: the
 * day a second chain gets a router, USDC there would reuse the BSC USDC key.
 * It is not fixed here on purpose. Adding the chain id changes the tag, which
 * changes every derived address (checked: the USDC child of a fixed master
 * moves from 0xEaF9ec…BEd0 to 0x862B34…9C5F), which orphans every mandate
 * already granted to the old address with no way to enumerate them from this
 * side. Only BSC has routers today, so the collision is not reachable yet.
 * Making the tag chain-scoped is a migration that needs the owner's go-ahead
 * and a re-grant path, and it must land before any second-chain deployment.
 * tests/manager-key.test.ts pins the derived addresses so this cannot happen
 * by accident.
 */
export function deriveManagerKey(master: ManagerKey, symbol: string): ManagerKey {
  const childPriv = keccak256(concat([master.privateKey, stringToHex(`agripinaa-managed:${symbol}`)]));
  const account = privateKeyToAccount(childPriv);
  return { privateKey: childPriv, address: account.address, publicKey: account.publicKey };
}

export interface ManagerKeySet {
  master: ManagerKey;
  /** The key a session for `symbol` must be granted to. */
  byToken: Map<string, ManagerKey>;
  /** Every manager key by lowercase public key, for signer selection at tick time. */
  byPublicKey: Map<string, ManagerKey>;
}

/**
 * The primary MUST be one of the symbols being built. If it is not, no token
 * holds the master key: every symbol gets a derived key, every mandate granted
 * to the master public key is orphaned, and the first sign of it is the
 * executor's signer check throwing at tick time on live user funds. Fail here
 * instead, at boot, where the stack trace names the caller.
 */
function assertPrimaryIsMember(symbols: readonly string[], primary: string): void {
  if (!symbols.includes(primary)) {
    throw new Error(
      `primary managed token ${primary} is not among [${symbols.join(', ')}]: no token would hold the master key`,
    );
  }
}

/**
 * Build a manager key set from an already-loaded master: the PRIMARY token
 * keeps the master key (so an already-granted mandate keeps running untouched),
 * and every other managed token derives its own distinct key.
 *
 * `symbols` is iteration order only. Which token holds the master key is
 * decided by `primary` alone, never by position, so reordering the caller's
 * display array cannot rotate an on-chain key identity.
 */
export function managerKeySetFrom(
  master: ManagerKey,
  symbols: readonly string[],
  primary: string,
): ManagerKeySet {
  assertPrimaryIsMember(symbols, primary);
  const byToken = new Map<string, ManagerKey>();
  const byPublicKey = new Map<string, ManagerKey>([[master.publicKey.toLowerCase(), master]]);
  for (const sym of symbols) {
    const key = sym === primary ? master : deriveManagerKey(master, sym);
    byToken.set(sym, key);
    byPublicKey.set(key.publicKey.toLowerCase(), key);
  }
  return { master, byToken, byPublicKey };
}

/**
 * The agent's full set of manager keys, loaded from its master key file.
 * Returns null if the agent has no master key file. A `primary` outside
 * `symbols` throws before the file is read: that is a caller bug either way.
 */
export function buildManagerKeySet(
  agent: string,
  symbols: readonly string[],
  primary: string,
): ManagerKeySet | null {
  assertPrimaryIsMember(symbols, primary);
  const master = loadManagerKey(agent);
  if (!master) return null;
  return managerKeySetFrom(master, symbols, primary);
}
