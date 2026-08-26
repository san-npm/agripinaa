import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC,
  RETIRED_YIELD_ROUTER_BSC,
  RETIRED_YIELD_ROUTER_BSC_USDC,
  RETIRED_YIELD_ROUTER_V2_BSC,
  RETIRED_YIELD_ROUTER_V2_BSC_USDC,
  ROUTER_ACTIONS,
  YIELD_ROUTER_BSC,
} from '@agripinaa/shared/contracts';

import {
  managedServiceStatus,
  managedUnwindCall,
  resolveManagedRouterDeployment,
} from '../src/lib/managed-router';
import {
  destinationProblem,
  destinationCodeProblem,
  destinationCodeQuorumProblem,
  classifyManagedVenue,
  managedPolicyDisplay,
  MAX_ACCOUNT_HISTORY_CHUNKS,
  planRotationHistoryRanges,
  shouldOfferManagedHandoffRetry,
} from '../src/lib/managed-pure';

test('managed venue classification surfaces a debt-blocked split position', () => {
  assert.equal(classifyManagedVenue(0n, 60n, 40n, 1n), 'split');
  assert.equal(classifyManagedVenue(100n, 60n, 0n, 1n), 'idle');
  assert.equal(classifyManagedVenue(0n, 60n, 0n, 1n), 'aave');
});

test('owner unwind targets the active debt-complete router', () => {
  assert.deepEqual(managedUnwindCall(56, 'USDT'), {
    to: YIELD_ROUTER_BSC.address,
    data: ROUTER_ACTIONS.toIdle.selector,
  });
});

test('legacy recovery resolves retired metadata but builds the unwind only to v3', () => {
  assert.equal(
    resolveManagedRouterDeployment(56, 'USDT', RETIRED_YIELD_ROUTER_BSC.address)?.address,
    RETIRED_YIELD_ROUTER_BSC.address,
  );
  const call = (managedUnwindCall as (...args: unknown[]) => { to: string })(
    56,
    'USDT',
    RETIRED_YIELD_ROUTER_BSC.address,
  );
  assert.equal(call.to, YIELD_ROUTER_BSC.address);
  assert.notEqual(call.to, RETIRED_YIELD_ROUTER_BSC.address);
});

test('withdrawal destinations reject every retired and decommissioned router', () => {
  const account = '0x1111111111111111111111111111111111111111';
  for (const address of [
    RETIRED_YIELD_ROUTER_BSC.address,
    RETIRED_YIELD_ROUTER_BSC_USDC.address,
    RETIRED_YIELD_ROUTER_V2_BSC.address,
    RETIRED_YIELD_ROUTER_V2_BSC_USDC.address,
    ...DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC,
  ]) {
    assert.match(destinationProblem(address.toLowerCase(), account, 56) ?? '', /contract address/);
  }
});

test('withdrawal destinations reject reserved and precompile addresses', () => {
  const account = '0x1111111111111111111111111111111111111111';
  for (const address of [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000100',
    '0x000000000000000000000000000000000000ffff',
  ]) {
    assert.match(destinationProblem(address, account, 56) ?? '', /reserved or precompile/);
  }
});

test('live destination validation rejects arbitrary contracts, not only known routers', async () => {
  const wbnb = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
  const problem = await destinationCodeProblem(wbnb, async () => '0x6000');
  assert.ok(problem);
  assert.match(problem, /Contract destinations are unsupported/);
  assert.equal(await destinationCodeProblem(wbnb, async () => '0x'), null);
  assert.match(destinationCodeQuorumProblem(['0x', '0x6000', '0x6000']) ?? '', /Contract destinations/);
  assert.equal(destinationCodeQuorumProblem(['0x6000', '0x', '0x']), null);
  assert.throws(() => destinationCodeQuorumProblem(['0x6000', '0x']), /quorum unavailable/);
});

test('retired key validity never becomes a managing service state', () => {
  assert.deepEqual(managedServiceStatus('valid', false, 'ready'), {
    sessionValid: true,
    active: true,
    label: 'managing',
  });
  assert.deepEqual(managedServiceStatus('valid', true), {
    sessionValid: true,
    active: false,
    label: 'recovery only · key live',
  });
  assert.equal(managedServiceStatus('unknown', false).active, false);
  assert.equal(managedServiceStatus('invalid', true).label, 'recovery only · key stopped');
  assert.equal(managedServiceStatus('unknown', true).label, 'recovery only · authority unknown');
  assert.equal(managedServiceStatus('valid', false, 'halted').label, 'agent halted');
  assert.equal(managedServiceStatus('valid', false, 'unavailable').active, false);
});

test('a recoverable live session can retry a failed runner handoff without a new grant', () => {
  assert.equal(shouldOfferManagedHandoffRetry('valid', false, 'not-registered', 'pending'), true);
  assert.equal(shouldOfferManagedHandoffRetry('valid', false, 'unavailable', 'pending'), true);
  assert.equal(shouldOfferManagedHandoffRetry('valid', false, 'ready', 'registered'), false);
  assert.equal(shouldOfferManagedHandoffRetry('unknown', false, 'not-registered', 'pending'), false);
  assert.equal(shouldOfferManagedHandoffRetry('valid', true, 'not-registered', 'pending'), false);
});

test('account history planning is newest-first, contiguous, and request-bounded', () => {
  const latest = 118_145_739n;
  const deploy = latest - 1_095_324n;
  const plan = planRotationHistoryRanges(deploy, latest, 9_000n);
  assert.equal(plan.ranges.length, MAX_ACCOUNT_HISTORY_CHUNKS);
  assert.equal(plan.complete, false);
  assert.equal(plan.ranges[0]?.to, latest);
  for (let i = 1; i < plan.ranges.length; i++) {
    assert.equal(plan.ranges[i - 1]!.from - 1n, plan.ranges[i]!.to);
  }

  const complete = planRotationHistoryRanges(100n, 150n, 20n);
  assert.equal(complete.complete, true);
  assert.equal(complete.ranges.length, 3);
  assert.equal(complete.ranges.at(-1)?.from, 100n);
});

test('managed policy copy comes from each agent manifest', () => {
  assert.deepEqual(managedPolicyDisplay({ tokenId: '269705', slug: 'yield' }), {
    hysteresisBps: 50,
    thresholdInclusive: false,
    confirmations: 2,
    checkEveryHours: null,
    minHoursBetweenMoves: null,
  });
  assert.deepEqual(managedPolicyDisplay({ tokenId: '', slug: 'yield-b' }), {
    hysteresisBps: 120,
    thresholdInclusive: true,
    confirmations: 3,
    checkEveryHours: 12,
    minHoursBetweenMoves: 48,
  });
});

test('legacy recovery fails closed on a token or chain mismatch', () => {
  assert.equal(
    resolveManagedRouterDeployment(56, 'USDT', RETIRED_YIELD_ROUTER_BSC_USDC.address),
    undefined,
  );
  assert.throws(
    () => managedUnwindCall(97, 'USDT'),
    /no debt-complete YieldRouter/,
  );
});
