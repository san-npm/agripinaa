import { pinnedManagerKeyAddress } from '@agripinaa/shared/agents';
import { isAddress, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

/**
 * The runner-reported manager key, validated before the browser grants a
 * session to it. Kept apart from managed.ts (which pulls in the Altana SDK)
 * so the check itself is unit-testable in Node.
 */

export interface ManagerKeyInfo {
  agent: string;
  publicKey: Hex;
  address: Hex;
}

/** SEC1 uncompressed point: 0x04 || x || y, 65 bytes. */
const SEC1_UNCOMPRESSED = /^0x04[0-9a-fA-F]{128}$/;

/**
 * The runner base is resolved from a rotating quick-tunnel hostname, and a
 * dead name could in principle be re-issued to someone else, so what the
 * runner reports is the point where a hijacked base would become a session
 * grantee. Three checks close it: both fields have the right shape, the
 * address is the one the public key derives to (the grant is made to the
 * point, so the pin cannot be checked on the address alone), and where the
 * registry pins an address for this agent and token, the report matches it.
 * An agent with no pin yet (the Steward, whose session key is not generated)
 * is accepted with a warning so it can be activated once its key exists.
 */
export function validateManagerKey(agent: string, token: string, body: unknown): ManagerKeyInfo {
  const record = (body && typeof body === 'object' ? body : {}) as { publicKey?: unknown; address?: unknown };
  const { publicKey, address } = record;
  if (typeof publicKey !== 'string' || !SEC1_UNCOMPRESSED.test(publicKey)) {
    throw new Error('manager key rejected: public key is not a 65-byte SEC1 point');
  }
  if (typeof address !== 'string' || !isAddress(address)) {
    throw new Error('manager key rejected: address is not an EVM address');
  }
  if (publicKeyToAddress(publicKey as Hex).toLowerCase() !== address.toLowerCase()) {
    throw new Error('manager key rejected: address does not belong to the public key');
  }
  const pin = pinnedManagerKeyAddress(agent, token);
  if (pin) {
    if (pin.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`manager key rejected: ${agent} reported a ${token} key that does not match the pinned manager key`);
    }
  } else {
    console.warn(`manager key for ${agent}/${token} is not pinned in the registry; accepting ${address} as reported`);
  }
  return { agent, publicKey: publicKey as Hex, address: address as Hex };
}

/**
 * Fetch the agent's public manager key for a specific token (via the server
 * proxy). Each token has its OWN key, so a USDC grant never shares the USDT
 * key's on-chain identity, expiry, or revocation.
 */
export async function fetchManagerKey(agent: string, token = 'USDT'): Promise<ManagerKeyInfo> {
  const res = await fetch(`/api/managed/${agent}/manager-key?token=${encodeURIComponent(token)}`);
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw new Error(typeof error === 'string' ? error : `manager key unavailable (${res.status})`);
  }
  return validateManagerKey(agent, token, body);
}
