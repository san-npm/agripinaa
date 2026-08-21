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
 * Build the agent's full set of manager keys: the PRIMARY token keeps the
 * master key (so an already-granted mandate keeps running untouched), and every
 * other managed token derives its own distinct key. Returns null if the agent
 * has no master key file.
 */
export function buildManagerKeySet(
  agent: string,
  symbols: readonly string[],
  primary: string,
): ManagerKeySet | null {
  const master = loadManagerKey(agent);
  if (!master) return null;
  const byToken = new Map<string, ManagerKey>();
  const byPublicKey = new Map<string, ManagerKey>([[master.publicKey.toLowerCase(), master]]);
  for (const sym of symbols) {
    const key = sym === primary ? master : deriveManagerKey(master, sym);
    byToken.set(sym, key);
    byPublicKey.set(key.publicKey.toLowerCase(), key);
  }
  return { master, byToken, byPublicKey };
}
