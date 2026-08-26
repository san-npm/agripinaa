import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recoveryRouterByAddress,
  recoveryRouterFromAllowlist,
  RETIRED_YIELD_ROUTER_BSC,
  RETIRED_YIELD_ROUTER_BSC_USDC,
  routerByAddress,
  routerFor,
  YIELD_ROUTER_BSC,
} from '../src/contracts';

test('retired routers are recovery-only, never active activation targets', () => {
  assert.equal(routerFor(56, 'USDT')?.address, YIELD_ROUTER_BSC.address);
  assert.equal(routerByAddress(RETIRED_YIELD_ROUTER_BSC.address), undefined);
  assert.equal(routerByAddress(RETIRED_YIELD_ROUTER_BSC_USDC.address), undefined);
});

test('owner recovery recognizes the exact superseded router', () => {
  assert.equal(
    recoveryRouterByAddress(RETIRED_YIELD_ROUTER_BSC.address.toLowerCase())?.address,
    RETIRED_YIELD_ROUTER_BSC.address,
  );
  assert.equal(
    recoveryRouterByAddress(RETIRED_YIELD_ROUTER_BSC_USDC.address)?.symbol,
    'USDC',
  );
});

test('a saved scope must resolve to exactly one recovery router on its chain', () => {
  assert.equal(
    recoveryRouterFromAllowlist([RETIRED_YIELD_ROUTER_BSC.address], 56)?.address,
    RETIRED_YIELD_ROUTER_BSC.address,
  );
  assert.equal(recoveryRouterFromAllowlist([RETIRED_YIELD_ROUTER_BSC.address], 97), undefined);
  assert.equal(recoveryRouterFromAllowlist(['0x0000000000000000000000000000000000000001'], 56), undefined);
  assert.equal(
    recoveryRouterFromAllowlist(
      [RETIRED_YIELD_ROUTER_BSC.address, YIELD_ROUTER_BSC.address],
      56,
    ),
    undefined,
  );
});
