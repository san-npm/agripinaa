import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETIRED_YIELD_ROUTER_BSC,
  RETIRED_YIELD_ROUTER_BSC_USDC,
  ROUTER_ACTIONS,
  YIELD_ROUTER_BSC,
} from '@agripinaa/shared/contracts';

import { managedUnwindCall, resolveManagedRouterDeployment } from '../src/lib/managed-router';

test('a normal unwind still targets the active guarded router', () => {
  assert.deepEqual(managedUnwindCall(56, 'USDT'), {
    to: YIELD_ROUTER_BSC.address,
    data: ROUTER_ACTIONS.toIdle.selector,
  });
});

test('legacy recovery targets the exact retired router saved in the session', () => {
  assert.deepEqual(managedUnwindCall(56, 'USDT', RETIRED_YIELD_ROUTER_BSC.address), {
    to: RETIRED_YIELD_ROUTER_BSC.address,
    data: ROUTER_ACTIONS.toIdle.selector,
  });
});

test('legacy recovery fails closed on a token or chain mismatch', () => {
  assert.equal(
    resolveManagedRouterDeployment(56, 'USDT', RETIRED_YIELD_ROUTER_BSC_USDC.address),
    undefined,
  );
  assert.throws(
    () => managedUnwindCall(97, 'USDT', RETIRED_YIELD_ROUTER_BSC.address),
    /no matching YieldRouter/,
  );
});
