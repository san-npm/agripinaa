/**
 * Read-only on-chain session-key authority checks. Deliberately free of any
 * Altana SDK dependency so the web app can render authority panels with zero
 * credentials: viem public reads only.
 *
 * ABI and derivation confirmed against @altananetwork/sdk@0.7.0 sources
 * (dist/internal/keystore.js): KeyStore v0 convention is
 * keyId = keccak256(publicKey) with publicKey as SEC1 uncompressed bytes
 * (0x04 || x || y, 65 bytes), and the registry read is
 * isValidKey(address user, bytes32 keyId) view returns (bool), true iff the
 * key is registered, unexpired, and unrevoked. Addresses below match the
 * SDK's BNB and BNB_TESTNET NetworkConfig keyStore fields exactly.
 */

import { createPublicClient, http, keccak256, type Hex } from 'viem';
import { BSC_MAINNET, BSC_TESTNET } from '@agripinaa/shared/chains';
import type { Address } from './scope';

export const KEYSTORE_ADDRESSES: Record<number, Address> = {
  56: '0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a',
  97: '0x6b8361C29d05D498b1a12B54A37310f94171E94A',
};

export const KEYSTORE_READ_ABI = [
  {
    name: 'isValidKey',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getKeys',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }],
  },
  {
    name: 'getPublicKey',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ type: 'bytes' }],
  },
] as const;

/** KeyStore v0 keyId convention: keccak256 of the SEC1-encoded public key. */
export function keyIdFromPublicKey(sessionPublicKey: Hex): Hex {
  return keccak256(sessionPublicKey);
}

function rpcUrlFor(chainId: number): string {
  if (chainId === BSC_MAINNET.id) return BSC_MAINNET.rpcUrls[0];
  if (chainId === BSC_TESTNET.id) return BSC_TESTNET.rpcUrls[0];
  throw new Error(
    `isSessionKeyValid: no default RPC for chainId ${chainId}; supported chains are 56 and 97`,
  );
}

export interface IsSessionKeyValidArgs {
  chainId: number;
  /** The smart-account (wallet) address the session was granted on. */
  account: Address;
  /** SEC1 uncompressed public key of the session signer (0x04 || x || y). */
  sessionPublicKey: Hex;
  /** Override the default public RPC (e.g. a paid endpoint). */
  rpcUrl?: string;
}

/**
 * True iff the session key is currently registered, unexpired, and unrevoked
 * in the KeyStore registry. False is a definitive negative (never registered,
 * expired, or revoked); the call does not revert for unknown keys.
 */
export async function isSessionKeyValid(args: IsSessionKeyValidArgs): Promise<boolean> {
  const { chainId, account, sessionPublicKey, rpcUrl } = args;
  const keyStore = KEYSTORE_ADDRESSES[chainId];
  if (!keyStore) {
    throw new Error(
      `isSessionKeyValid: no KeyStore deployment known for chainId ${chainId}; supported chains are 56 and 97`,
    );
  }
  const client = createPublicClient({
    transport: http(rpcUrl ?? rpcUrlFor(chainId)),
  });
  return client.readContract({
    address: keyStore,
    abi: KEYSTORE_READ_ABI,
    functionName: 'isValidKey',
    args: [account, keyIdFromPublicKey(sessionPublicKey)],
  });
}
