/**
 * The per-agent manager session key. This is the key users grant a scoped
 * session to; the agent signs router calls with it. It lives in its own wallet
 * file (wallets/agent-<name>-session.json) so it is distinct from the agent's
 * own-capital wallet and can be rotated without touching agent funds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Hex } from 'viem';
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

/** Load the agent's manager key, or null if it was never generated. */
export function loadManagerKey(agent: string): ManagerKey | null {
  const file = managerKeyFile(agent);
  if (!existsSync(file)) return null;
  const { privateKey } = JSON.parse(readFileSync(file, 'utf8')) as { privateKey: Hex };
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address, publicKey: account.publicKey };
}
