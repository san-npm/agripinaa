import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';

import {
  DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC,
  isDebtCompleteRouter,
  isDebtCompleteRouterRuntime,
  isDebtCompleteRouterRuntimeQuorum,
  isManagedContractAddress,
  recoveryRouterByAddress,
  recoveryRouterFromAllowlist,
  RETIRED_YIELD_ROUTER_BSC,
  RETIRED_YIELD_ROUTER_BSC_USDC,
  RETIRED_YIELD_ROUTER_V2_BSC,
  RETIRED_YIELD_ROUTER_V2_BSC_USDC,
  routerByAddress,
  routerFor,
  YIELD_ROUTER_BSC,
} from '../src/contracts';

test('v3 activation requires both a pinned hash and matching live runtime/version', async () => {
  assert.equal(isDebtCompleteRouter(YIELD_ROUTER_BSC), true);
  const code = '0x6000' as const;
  const candidate = {
    ...YIELD_ROUTER_BSC,
    debtGuardVersion: 3,
    runtimeCodeHash: keccak256(code),
  };
  assert.equal(isDebtCompleteRouter({ ...candidate, runtimeCodeHash: undefined }), false);
  assert.equal(isDebtCompleteRouter(candidate), true);
  assert.equal(await isDebtCompleteRouterRuntime({
    async getCode() { return code; },
    async readContract() { return 3n; },
  }, candidate), true);
  assert.equal(await isDebtCompleteRouterRuntime({
    async getCode() { return '0x6001'; },
    async readContract() { return 3n; },
  }, candidate), false);
});

test('one divergent RPC cannot authorize router approvals through quorum', async () => {
  const code = '0x6000' as const;
  const candidate = {
    ...YIELD_ROUTER_BSC,
    debtGuardVersion: 3,
    runtimeCodeHash: keccak256(code),
  };
  const honest = {
    async getCode() { return code; },
    async readContract() { return 3n; },
  };
  const divergent = {
    async getCode() { return '0x6001' as const; },
    async readContract() { return 99n; },
  };
  assert.equal(await isDebtCompleteRouterRuntimeQuorum([divergent, honest, honest], candidate), true);
  assert.equal(await isDebtCompleteRouterRuntimeQuorum([honest, divergent, divergent], candidate), false);
});

test('retired routers are recovery-only, never active activation targets', () => {
  assert.equal(routerFor(56, 'USDT')?.address, YIELD_ROUTER_BSC.address);
  assert.equal(routerByAddress(RETIRED_YIELD_ROUTER_BSC.address), undefined);
  assert.equal(routerByAddress(RETIRED_YIELD_ROUTER_BSC_USDC.address), undefined);
  assert.equal(routerByAddress(RETIRED_YIELD_ROUTER_V2_BSC.address), undefined);
  assert.equal(routerByAddress(RETIRED_YIELD_ROUTER_V2_BSC_USDC.address), undefined);
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
    recoveryRouterFromAllowlist([RETIRED_YIELD_ROUTER_V2_BSC.address], 56)?.address,
    RETIRED_YIELD_ROUTER_V2_BSC.address,
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

test('withdrawal denylist covers active, retired, decommissioned, and dependency contracts', () => {
  for (const address of [
    YIELD_ROUTER_BSC.address,
    YIELD_ROUTER_BSC.usdt,
    YIELD_ROUTER_BSC.aUsdt,
    YIELD_ROUTER_BSC.vUsdt,
    YIELD_ROUTER_BSC.aavePool,
    RETIRED_YIELD_ROUTER_BSC.address,
    RETIRED_YIELD_ROUTER_BSC_USDC.address,
    RETIRED_YIELD_ROUTER_V2_BSC.address,
    RETIRED_YIELD_ROUTER_V2_BSC_USDC.address,
    ...DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC,
  ]) {
    assert.equal(isManagedContractAddress(address, 56), true, address);
  }
  assert.equal(isManagedContractAddress(DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC[0], 97), false);
  assert.equal(isManagedContractAddress('0x0000000000000000000000000000000000000001', 56), false);
});
