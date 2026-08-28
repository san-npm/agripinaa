import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BSC_MAINNET, BSC_MAINNET_RPC_SOURCES } from '../src/chains';

test('authority quorum endpoints are independent RPC operators', () => {
  assert.equal(
    new Set(BSC_MAINNET_RPC_SOURCES.map(({ operator }) => operator)).size,
    BSC_MAINNET_RPC_SOURCES.length,
  );
  assert.deepEqual(
    BSC_MAINNET.rpcUrls,
    BSC_MAINNET_RPC_SOURCES.map(({ url }) => url),
  );
});
