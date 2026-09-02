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
import { publicKeyToAddress } from 'viem/accounts';
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
const PORTO_ANY_SELECTOR = '0x32323232' as Hex;
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
  /**
   * Exact Porto relay orchestrator injected into every relay-backed session.
   * Porto adds an any-selector call for this one target after converting the
   * application policy; omitting this field means no injected permission is
   * expected. Callers must pin the deployment rather than accept any target.
   */
  relayOrchestrator?: Address;
}

interface AccountSpendInfo {
  token: Address;
  period: number;
  limit: bigint;
}

export interface AccountKeyDescriptor {
  expiry: number | bigint;
  keyType: number;
  isSuperAdmin: boolean;
  publicKey: Hex;
}

export function accountKeyIdentityMatches(
  key: AccountKeyDescriptor,
  expectedAddress: Address,
): boolean {
  const address = expectedAddress.toLowerCase().slice(2);
  const raw = key.publicKey.toLowerCase().slice(2);
  // Porto serializes secp256k1 as keyType 2 and stores the 20-byte address
  // either directly or left-padded to bytes32. A suffix match would also admit
  // an External key with an attacker-controlled prefix.
  const canonicalIdentity = raw === address || raw === `${'0'.repeat(24)}${address}`;
  return key.keyType === 2 && !key.isSuperAdmin && canonicalIdentity;
}

export function accountKeyDescriptorMatches(
  key: AccountKeyDescriptor,
  expectedAddress: Address,
  expectedExpiry: number,
): boolean {
  return accountKeyIdentityMatches(key, expectedAddress)
    && Number(key.expiry) === expectedExpiry;
}

const SEC1_UNCOMPRESSED_PUBLIC_KEY = /^0x04[0-9a-fA-F]{128}$/;

/**
 * Join the public KeyStore registry to the account's authoritative key list.
 * Recovery must revoke every currently-authorized secp256k1 session, including
 * sessions saved by a different browser. An active account-local session that
 * is absent from KeyStore cannot be safely reconstructed, so fail closed.
 */
export function resolveActiveAccountSessionPublicKeys(input: {
  keyIds: readonly Hex[];
  publicKeys: readonly Hex[];
  accountKeys: readonly AccountKeyDescriptor[];
  blockTimestamp: bigint;
}): Hex[] {
  if (input.keyIds.length !== input.publicKeys.length) {
    throw new Error('KeyStore returned inconsistent key identifiers and public keys');
  }
  const registered = input.publicKeys.map((publicKey, index) => {
    if (!SEC1_UNCOMPRESSED_PUBLIC_KEY.test(publicKey)) return null;
    if (keyIdFromPublicKey(publicKey).toLowerCase() !== input.keyIds[index]!.toLowerCase()) {
      throw new Error('KeyStore returned public-key bytes that do not match their key id');
    }
    return { publicKey, address: publicKeyToAddress(publicKey) };
  }).filter((entry): entry is { publicKey: Hex; address: Address } => entry !== null);

  const activeSessions = input.accountKeys.filter((key) =>
    !key.isSuperAdmin && BigInt(key.expiry) > input.blockTimestamp,
  );
  if (activeSessions.some((key) => key.keyType !== 2)) {
    throw new Error('An active account session uses an unsupported key type');
  }
  const resolved = activeSessions.map((key) => {
    const matches = registered.filter((entry) => accountKeyIdentityMatches(key, entry.address));
    if (matches.length !== 1) {
      throw new Error('An active account session is missing or ambiguous in the public KeyStore registry');
    }
    return matches[0]!.publicKey;
  });
  return [...new Map(resolved.map((publicKey) => [publicKey.toLowerCase(), publicKey])).values()]
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
}

function packedSelector(to: Address, selector: Hex): Hex {
  // GuardedExecutor._packCanExecute puts the 20-byte target in the upper
  // bytes and the 4-byte selector in the lower bytes, leaving eight zero bytes
  // between them.
  return `0x${to.slice(2).toLowerCase()}${'0'.repeat(16)}${selector.slice(2).toLowerCase()}`;
}

function packedCall(to: Address, signature: string): Hex {
  return packedSelector(to, toFunctionSelector(signature));
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
 * Porto's relay conversion also appends one any-selector permission for its
 * orchestrator. That permission is accepted only when the caller supplies the
 * exact pinned orchestrator address; every other extra execute still fails.
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
  if (args.expected.relayOrchestrator) {
    expectedExecutes.push(packedSelector(args.expected.relayOrchestrator, PORTO_ANY_SELECTOR));
  }
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
  if (chainId === BSC_MAINNET.id) return BSC_MAINNET.rpcUrls[0]!;
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
  // Conflicting latest-state views are not a negative answer. In particular,
  // two stale providers must not outvote one provider that already sees an
  // irreversible key registration. Require every fulfilled independent source
  // to agree, with at least two successful reads.
  if (values.length >= 2 && values.every((value) => value === values[0])) {
    return values[0]!;
  }
  const firstError = settled.find((result) => result.status === 'rejected');
  if (firstError?.status === 'rejected' && values.length === 0) throw firstError.reason;
  throw new Error('authority RPC quorum unavailable or disagreed');
}

async function quorumValueRead<T>(
  chainId: number,
  rpcUrl: string | undefined,
  read: (client: ReturnType<typeof createPublicClient>) => Promise<T>,
  fingerprint: (value: T) => string,
): Promise<T> {
  const urls = verificationRpcUrls(chainId, rpcUrl);
  const settled = await Promise.allSettled(
    urls.map((url) => read(createPublicClient({ transport: http(url) }))),
  );
  const values = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (urls.length === 1 && values.length === 1) return values[0]!;

  const groups = new Map<string, { count: number; value: T }>();
  for (const value of values) {
    const key = fingerprint(value);
    const group = groups.get(key) ?? { count: 0, value };
    group.count += 1;
    groups.set(key, group);
  }
  const unanimous = groups.size === 1 ? groups.values().next().value : undefined;
  if (unanimous && unanimous.count >= 2) return unanimous.value;
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

/**
 * True iff this exact public key has ever been registered for the account.
 * Unlike `isValidKey`, KeyStore's `getPublicKey` retains the bytes after an
 * expiry or monotonic revocation, so this distinguishes a fresh key from one
 * that must never be submitted to `registerKey` again.
 */
export async function wasSessionKeyRegistered(args: IsSessionKeyValidArgs): Promise<boolean> {
  const { chainId, account, sessionPublicKey, rpcUrl } = args;
  const keyStore = KEYSTORE_ADDRESSES[chainId];
  if (!keyStore) {
    throw new Error(
      `wasSessionKeyRegistered: no KeyStore deployment known for chainId ${chainId}; supported chains are 56 and 97`,
    );
  }
  const publicKey = await quorumValueRead(chainId, rpcUrl, (client) => client.readContract({
    address: keyStore,
    abi: KEYSTORE_READ_ABI,
    functionName: 'getPublicKey',
    args: [account, keyIdFromPublicKey(sessionPublicKey)],
  }), (value) => value.toLowerCase());
  if (publicKey === '0x') return false;
  if (publicKey.toLowerCase() !== sessionPublicKey.toLowerCase()) {
    throw new Error('KeyStore returned public-key bytes that do not match their key id');
  }
  return true;
}

/**
 * Enumerate every live secp256k1 session authorized by the smart account.
 * Each provider reads a single block snapshot; two independent providers must
 * return the same sorted public-key set before recovery may mutate authority.
 */
export async function listActiveAccountSessionPublicKeys(
  args: Pick<IsSessionKeyValidArgs, 'chainId' | 'account' | 'rpcUrl'>,
): Promise<Hex[]> {
  const keyStore = KEYSTORE_ADDRESSES[args.chainId];
  if (!keyStore) {
    throw new Error(
      `listActiveAccountSessionPublicKeys: no KeyStore deployment known for chainId ${args.chainId}; supported chains are 56 and 97`,
    );
  }
  return quorumValueRead(args.chainId, args.rpcUrl, async (client) => {
    const block = await client.getBlock({ blockTag: 'latest' });
    const blockNumber = block.number;
    const [keyIds, accountResult] = await Promise.all([
      client.readContract({
        address: keyStore,
        abi: KEYSTORE_READ_ABI,
        functionName: 'getKeys',
        args: [args.account],
        blockNumber,
      }),
      client.readContract({
        address: args.account,
        abi: ACCOUNT_KEYS_READ_ABI,
        functionName: 'getKeys',
        blockNumber,
      }),
    ]);
    const publicKeys = await Promise.all(keyIds.map((keyId) => client.readContract({
      address: keyStore,
      abi: KEYSTORE_READ_ABI,
      functionName: 'getPublicKey',
      args: [args.account, keyId],
      blockNumber,
    })));
    return resolveActiveAccountSessionPublicKeys({
      keyIds,
      publicKeys,
      accountKeys: accountResult[0],
      blockTimestamp: block.timestamp,
    });
  }, (publicKeys) => publicKeys.map((key) => key.toLowerCase()).join(','));
}

export interface FindAccountSessionExpiryArgs {
  chainId: number;
  /** The smart-account address whose local descriptors are inspected. */
  account: Address;
  /** Secp256k1 address derived from the pinned manager public key. */
  sessionAddress: Address;
  /** Override the default public RPC (e.g. a paid endpoint). */
  rpcUrl?: string;
}

/**
 * Recover the expiry of an already-authorized manager identity. This is a
 * quorum read and returns null only when the canonical identity is absent.
 * Exact permissions must still be checked with
 * isAccountSessionDescriptorValid before the descriptor is reused.
 */
export async function findAccountSessionExpiry(
  args: FindAccountSessionExpiryArgs,
): Promise<number | null> {
  return quorumValueRead(args.chainId, args.rpcUrl, async (client) => {
    const [keys] = await client.readContract({
      address: args.account,
      abi: ACCOUNT_KEYS_READ_ABI,
      functionName: 'getKeys',
    });
    const matches = keys.filter((key) => accountKeyIdentityMatches(key, args.sessionAddress));
    if (matches.length === 0) return null;
    if (matches.length !== 1) {
      throw new Error('account contains multiple descriptors for the same session identity');
    }
    const expiry = Number(matches[0]!.expiry);
    if (!Number.isSafeInteger(expiry) || expiry <= 0) {
      throw new Error('account session descriptor has an invalid expiry');
    }
    return expiry;
  }, (value) => value === null ? 'null' : String(value));
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
