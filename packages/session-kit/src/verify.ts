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

import { createPublicClient, http, keccak256, toFunctionSelector, type Hex } from 'viem';
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

export const ACCOUNT_KEYS_READ_ABI = [
  {
    name: 'getKeys',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: 'keys',
        type: 'tuple[]',
        components: [
          { name: 'expiry', type: 'uint40' },
          { name: 'keyType', type: 'uint8' },
          { name: 'isSuperAdmin', type: 'bool' },
          { name: 'publicKey', type: 'bytes' },
        ],
      },
      { name: 'keyHashes', type: 'bytes32[]' },
    ],
  },
] as const;

export const ACCOUNT_PERMISSIONS_READ_ABI = [
  {
    name: 'approvedSignatureCheckers',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'keyHash', type: 'bytes32' }],
    outputs: [{ type: 'address[]' }],
  },
  {
    name: 'canExecutePackedInfos',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'keyHash', type: 'bytes32' }],
    outputs: [{ type: 'bytes32[]' }],
  },
  {
    name: 'spendInfos',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'keyHash', type: 'bytes32' }],
    outputs: [{
      name: 'results',
      type: 'tuple[]',
      components: [
        { name: 'token', type: 'address' },
        { name: 'period', type: 'uint8' },
        { name: 'limit', type: 'uint256' },
        { name: 'spent', type: 'uint256' },
        { name: 'lastUpdated', type: 'uint256' },
        { name: 'currentSpent', type: 'uint256' },
        { name: 'current', type: 'uint256' },
      ],
    }],
  },
  {
    name: 'callCheckerInfos',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'keyHash', type: 'bytes32' }],
    outputs: [{
      name: 'results',
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'checker', type: 'address' },
      ],
    }],
  },
] as const;

const PORTO_ANY_KEYHASH = `0x${'32'.repeat(32)}` as Hex;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const SPEND_PERIOD = {
  minute: 0,
  hour: 1,
  day: 2,
  week: 3,
  month: 4,
  year: 5,
} as const;

export interface ExpectedAccountSessionPermissions {
  calls: readonly { to: Address; signature: string }[];
  spend: readonly {
    token?: Address;
    period: keyof typeof SPEND_PERIOD;
    limit: bigint;
  }[];
  /** Exact ERC-1271 callers approved for this key (empty/omitted means none). */
  signatureCheckers?: readonly Address[];
}

interface AccountSpendInfo {
  token: Address;
  period: number;
  limit: bigint;
}

interface AccountKeyDescriptor {
  expiry: number | bigint;
  keyType: number;
  isSuperAdmin: boolean;
  publicKey: Hex;
}

export function accountKeyDescriptorMatches(
  key: AccountKeyDescriptor,
  expectedAddress: Address,
  expectedExpiry: number,
): boolean {
  const address = expectedAddress.toLowerCase().slice(2);
  const raw = key.publicKey.toLowerCase().slice(2);
  // Porto serializes secp256k1 as keyType 2 and stores the 20-byte address
  // either directly or left-padded to bytes32. A suffix match would also admit
  // an External key with an attacker-controlled prefix.
  const canonicalIdentity = raw === address || raw === `${'0'.repeat(24)}${address}`;
  return key.keyType === 2
    && !key.isSuperAdmin
    && Number(key.expiry) === expectedExpiry
    && canonicalIdentity;
}

function packedCall(to: Address, signature: string): Hex {
  // GuardedExecutor._packCanExecute puts the 20-byte target in the upper
  // bytes and the 4-byte selector in the lower bytes, leaving eight zero bytes
  // between them.
  return `0x${to.slice(2).toLowerCase()}${'0'.repeat(16)}${toFunctionSelector(signature).slice(2).toLowerCase()}`;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const left = actual.map((value) => value.toLowerCase()).sort();
  const right = expected.map((value) => value.toLowerCase()).sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Exact account-local permission comparison. Mutable counters/timestamps in a
 * SpendInfo are deliberately excluded; token, period and ceiling are the
 * authorization. Global execute/checker grants and argument call checkers
 * expand a key beyond its local list, so any of them makes the descriptor
 * non-canonical. Session-local ERC-1271 checkers are accepted only when the
 * caller names their exact canonical set (Ophis uses the CoW settlement).
 */
export function accountSessionPermissionsMatch(args: {
  expected: ExpectedAccountSessionPermissions;
  executes: readonly Hex[];
  spends: readonly AccountSpendInfo[];
  callCheckers: readonly unknown[];
  signatureCheckers: readonly Address[];
  globalExecutes: readonly Hex[];
  globalCallCheckers: readonly unknown[];
  globalSignatureCheckers: readonly Address[];
}): boolean {
  if (
    args.callCheckers.length !== 0
    || args.globalExecutes.length !== 0
    || args.globalCallCheckers.length !== 0
    || args.globalSignatureCheckers.length !== 0
  ) {
    return false;
  }
  if (!sameStringSet(args.signatureCheckers, args.expected.signatureCheckers ?? [])) return false;
  const expectedExecutes = args.expected.calls.map((call) => packedCall(call.to, call.signature));
  if (!sameStringSet(args.executes, expectedExecutes)) return false;

  const actualSpends = args.spends.map((spend) =>
    `${spend.token.toLowerCase()}:${spend.period}:${spend.limit.toString()}`,
  );
  const expectedSpends = args.expected.spend.map((spend) =>
    `${(spend.token ?? ZERO_ADDRESS).toLowerCase()}:${SPEND_PERIOD[spend.period]}:${spend.limit.toString()}`,
  );
  return sameStringSet(actualSpends, expectedSpends);
}

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

function verificationRpcUrls(chainId: number, rpcUrl?: string): readonly string[] {
  if (rpcUrl) return [rpcUrl];
  const urls = chainId === BSC_MAINNET.id
    ? BSC_MAINNET.rpcUrls
    : chainId === BSC_TESTNET.id
      ? BSC_TESTNET.rpcUrls
      : [];
  if (urls.length === 0) void rpcUrlFor(chainId); // throws the canonical error
  return urls;
}

async function quorumBooleanRead(
  chainId: number,
  rpcUrl: string | undefined,
  read: (client: ReturnType<typeof createPublicClient>) => Promise<boolean>,
): Promise<boolean> {
  const urls = verificationRpcUrls(chainId, rpcUrl);
  const settled = await Promise.allSettled(
    urls.map((url) => read(createPublicClient({ transport: http(url) }))),
  );
  const values = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (urls.length === 1 && values.length === 1) return values[0]!;
  const trueVotes = values.filter(Boolean).length;
  const falseVotes = values.length - trueVotes;
  if (trueVotes >= 2) return true;
  if (falseVotes >= 2) return false;
  const firstError = settled.find((result) => result.status === 'rejected');
  if (firstError?.status === 'rejected' && values.length === 0) throw firstError.reason;
  throw new Error('authority RPC quorum unavailable or disagreed');
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
  return quorumBooleanRead(chainId, rpcUrl, (client) => client.readContract({
    address: keyStore,
    abi: KEYSTORE_READ_ABI,
    functionName: 'isValidKey',
    args: [account, keyIdFromPublicKey(sessionPublicKey)],
  }));
}

export interface IsAccountSessionDescriptorValidArgs extends IsSessionKeyValidArgs {
  /** Secp256k1 address derived from sessionPublicKey. */
  sessionAddress: Address;
  /** Exact expiry embedded in the account's authorized key descriptor. */
  expiry: number;
  /** Canonical call and spend scopes that must exist on the account exactly. */
  permissions: ExpectedAccountSessionPermissions;
}

/**
 * Confirm the smart account itself authorized this manager key with the exact
 * claimed expiry and exact permissions. KeyStore proves public registration;
 * these account-local reads prevent a client from inventing a different
 * descriptor for the same publicly visible manager key.
 */
export async function isAccountSessionDescriptorValid(
  args: IsAccountSessionDescriptorValidArgs,
): Promise<boolean> {
  return quorumBooleanRead(args.chainId, args.rpcUrl, async (client) => {
    const [keys, keyHashes] = await client.readContract({
      address: args.account,
      abi: ACCOUNT_KEYS_READ_ABI,
      functionName: 'getKeys',
    });
    const keyIndex = keys.findIndex((key) =>
      accountKeyDescriptorMatches(key, args.sessionAddress, args.expiry),
    );
    const keyHash = keyHashes[keyIndex];
    if (keyIndex < 0 || !keyHash) return false;
    const [
      executes,
      spends,
      callCheckers,
      signatureCheckers,
      globalExecutes,
      globalCallCheckers,
      globalSignatureCheckers,
    ] = await Promise.all([
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'canExecutePackedInfos',
        args: [keyHash],
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'spendInfos',
        args: [keyHash],
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'callCheckerInfos',
        args: [keyHash],
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'approvedSignatureCheckers',
        args: [keyHash],
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'canExecutePackedInfos',
        args: [PORTO_ANY_KEYHASH],
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'callCheckerInfos',
        args: [PORTO_ANY_KEYHASH],
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_PERMISSIONS_READ_ABI,
        functionName: 'approvedSignatureCheckers',
        args: [PORTO_ANY_KEYHASH],
      }),
    ]);
    return accountSessionPermissionsMatch({
      expected: args.permissions,
      executes,
      spends,
      callCheckers,
      signatureCheckers,
      globalExecutes,
      globalCallCheckers,
      globalSignatureCheckers,
    });
  });
}
