import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256 } from 'viem';

import { boundedLegacyFees, knownRawTransactionHash } from '../src/guarded-wallet-client';

test('wallet fee guard supplies an explicit gas limit and bounded price', () => {
  assert.deepEqual(
    boundedLegacyFees({ gasPrice: 1_000_000_000n }),
    { gas: 2_000_000n, gasPrice: 1_000_000_000n },
  );
});

test('wallet fee guard rejects excessive gas and maximum transaction cost', () => {
  assert.throws(
    () => boundedLegacyFees({ requestedGas: 2_000_001n, gasPrice: 1n }),
    /exceeds agent limit/,
  );
  assert.throws(
    () => boundedLegacyFees({ gasPrice: 6_000_000_000n }),
    /fee ceiling exceeded/,
  );
});

test('an already-known raw transaction recovers its deterministic hash', () => {
  const serialized = '0xdeadbeef' as const;
  assert.equal(
    knownRawTransactionHash(
      'eth_sendRawTransaction',
      [serialized],
      new Error('nonce too low; Details: already known'),
    ),
    keccak256(serialized),
  );
});

test('hash recovery refuses generic nonce errors and non-write RPCs', () => {
  assert.equal(
    knownRawTransactionHash(
      'eth_sendRawTransaction',
      ['0xdeadbeef'],
      new Error('nonce too low'),
    ),
    undefined,
  );
  assert.equal(
    knownRawTransactionHash('eth_call', ['0xdeadbeef'], new Error('already known')),
    undefined,
  );
  assert.equal(
    knownRawTransactionHash('eth_sendRawTransaction', ['0x'], new Error('already known')),
    undefined,
  );
});
