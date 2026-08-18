import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYSTORE_ADDRESSES,
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
