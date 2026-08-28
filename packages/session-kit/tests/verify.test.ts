import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYSTORE_ADDRESSES,
  accountKeyDescriptorMatches,
  accountKeyIdentityMatches,
  accountSessionPermissionsMatch,
  isSessionKeyValid,
  keyIdFromPublicKey,
  type Address,
} from '../src/index';

// Fixture captured from wallets/spike-b-session.json (public key only; the
// keyId was computed as keccak256(publicKey) per the KeyStore v0 convention
// in @altananetwork/sdk@0.7.0 dist/internal/keystore.js).
const SPIKE_ACCOUNT: Address = '0xACF6FC404F2B2D11D77Fe788f1eDaE5A7E0996Cf';
const SPIKE_PUBLIC_KEY =
  '0x04f63277b2c7a1446b0fc8083eb3645fe24d6232f29730ffb0707f3b7dfa1298fc90c3720379c802040f3ed228d0fe8e7a94da8e4354ce0ad3317211a25aed605b' as const;
const SPIKE_KEY_ID = '0x05a0ff131ad0359673e0b8fdbad507f82ddd5a178c6019522e858dc3405910da';

test('keyIdFromPublicKey matches the captured spike fixture', () => {
  assert.equal(keyIdFromPublicKey(SPIKE_PUBLIC_KEY), SPIKE_KEY_ID);
});

test('KeyStore deployments are pinned for 56 and 97', () => {
  assert.equal(KEYSTORE_ADDRESSES[56], '0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a');
  assert.equal(KEYSTORE_ADDRESSES[97], '0x6b8361C29d05D498b1a12B54A37310f94171E94A');
});

const ROUTER = '0x1111111111111111111111111111111111111111' as const;
const TOKEN = '0x2222222222222222222222222222222222222222' as const;
const ORCHESTRATOR = '0x3333333333333333333333333333333333333333' as const;
const EXPECTED_PERMISSIONS = {
  calls: [
    { to: ROUTER, signature: 'toAave()' },
    { to: ROUTER, signature: 'toVenus()' },
    { to: ROUTER, signature: 'toIdle()' },
  ],
  spend: [
    { token: TOKEN, period: 'day' as const, limit: 1_000_000n },
    { period: 'day' as const, limit: 5n },
  ],
};
const EXECUTES = [
  '0x11111111111111111111111111111111111111110000000000000000db1a4d6d',
  '0x1111111111111111111111111111111111111111000000000000000088b480df',
  '0x1111111111111111111111111111111111111111000000000000000018b5e866',
] as const;
const SPENDS = [
  { token: TOKEN, period: 2, limit: 1_000_000n },
  { token: '0x0000000000000000000000000000000000000000' as const, period: 2, limit: 5n },
];

test('account permissions require the exact granted call and spend mappings', () => {
  const base = {
    expected: EXPECTED_PERMISSIONS,
    executes: EXECUTES,
    spends: SPENDS,
    callCheckers: [],
    signatureCheckers: [],
    globalExecutes: [],
    globalCallCheckers: [],
    globalSignatureCheckers: [],
  };
  assert.equal(accountSessionPermissionsMatch(base), true);
  assert.equal(accountSessionPermissionsMatch({ ...base, executes: EXECUTES.slice(0, 2) }), false);
  assert.equal(accountSessionPermissionsMatch({
    ...base,
    spends: [{ ...SPENDS[0]!, limit: 999_999n }, SPENDS[1]!],
  }), false);
  assert.equal(accountSessionPermissionsMatch({
    ...base,
    executes: [...EXECUTES, '0x3333333333333333333333333333333333333333000000000000000012345678'],
  }), false);
  assert.equal(accountSessionPermissionsMatch({ ...base, globalExecutes: [EXECUTES[0]] }), false);
  assert.equal(accountSessionPermissionsMatch({ ...base, callCheckers: [{}] }), false);
  assert.equal(accountSessionPermissionsMatch({ ...base, signatureCheckers: [ROUTER] }), false);
  assert.equal(accountSessionPermissionsMatch({
    ...base,
    expected: { ...EXPECTED_PERMISSIONS, signatureCheckers: [ROUTER] },
    signatureCheckers: [ROUTER],
  }), true);
  assert.equal(accountSessionPermissionsMatch({
    ...base,
    expected: { ...EXPECTED_PERMISSIONS, signatureCheckers: [ROUTER] },
    signatureCheckers: [TOKEN],
  }), false);
});

test('the Porto relay execute is accepted only for the exact pinned orchestrator', () => {
  const relayExecute =
    '0x3333333333333333333333333333333333333333000000000000000032323232' as const;
  const base = {
    expected: { ...EXPECTED_PERMISSIONS, relayOrchestrator: ORCHESTRATOR },
    executes: [...EXECUTES, relayExecute],
    spends: SPENDS,
    callCheckers: [],
    signatureCheckers: [],
    globalExecutes: [],
    globalCallCheckers: [],
    globalSignatureCheckers: [],
  };
  assert.equal(accountSessionPermissionsMatch(base), true);
  assert.equal(accountSessionPermissionsMatch({ ...base, executes: EXECUTES }), false);
  assert.equal(accountSessionPermissionsMatch({
    ...base,
    expected: {
      ...EXPECTED_PERMISSIONS,
      relayOrchestrator: '0x4444444444444444444444444444444444444444',
    },
  }), false);
  assert.equal(accountSessionPermissionsMatch({
    ...base,
    executes: [...base.executes, relayExecute],
  }), false);
});

test('account key identity requires Porto canonical secp256k1 encoding', () => {
  const address = '0x1234567890123456789012345678901234567890' as const;
  const expiry = 1_900_000_000;
  const canonical = {
    expiry,
    keyType: 2,
    isSuperAdmin: false,
    publicKey: `0x${'00'.repeat(12)}${address.slice(2)}` as const,
  };
  assert.equal(accountKeyIdentityMatches(canonical, address), true);
  assert.equal(accountKeyDescriptorMatches(canonical, address, expiry), true);
  assert.equal(accountKeyDescriptorMatches(canonical, address, expiry + 1), false);
  assert.equal(accountKeyDescriptorMatches({
    ...canonical,
    keyType: 3,
    publicKey: `0x${'ab'.repeat(12)}${address.slice(2)}`,
  }, address, expiry), false);
  assert.equal(accountKeyDescriptorMatches({ ...canonical, isSuperAdmin: true }, address, expiry), false);
});

test('unsupported chainId throws instead of guessing an address', async () => {
  await assert.rejects(
    isSessionKeyValid({
      chainId: 1,
      account: SPIKE_ACCOUNT,
      sessionPublicKey: SPIKE_PUBLIC_KEY,
    }),
    /no KeyStore deployment known for chainId 1/,
  );
});

test('live testnet read: the revoked spike session reads as invalid (false, not a revert)', async (t) => {
  let valid: boolean;
  try {
    valid = await isSessionKeyValid({
      chainId: 97,
      account: SPIKE_ACCOUNT,
      sessionPublicKey: SPIKE_PUBLIC_KEY,
    });
  } catch (err) {
    // Skip only on transport failures; a contract revert must FAIL the test,
    // because isValidKey is a plain view that returns false for unknown keys.
    const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    if (/HttpRequestError|TimeoutError|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|network/i.test(text)) {
      t.skip(`testnet RPC unreachable: ${text.slice(0, 120)}`);
      return;
    }
    throw err;
  }
  assert.equal(valid, false);
});
