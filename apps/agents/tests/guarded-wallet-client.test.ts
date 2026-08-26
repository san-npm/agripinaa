import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundedLegacyFees } from '../src/guarded-wallet-client';

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
