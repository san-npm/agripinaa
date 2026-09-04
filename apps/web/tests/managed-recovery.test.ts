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
  OPHIS_VAULT_RELAYER_BSC,
  PANCAKE_V3_POSITION_MANAGER,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import { decodeFunctionData, erc20Abi } from 'viem';

import {
  managedServiceStatus,
  effectiveManagedPositionTokenId,
  managedRunnerSnapshot,
  managedUnwindCall,
  resolveManagedRouterDeployment,
} from '../src/lib/managed-router';
import {
  destinationProblem,
  destinationCodeProblem,
  destinationCodeQuorumProblem,
  isEip7702Delegation,
  classifyManagedVenue,
  managedPolicyDisplay,
  MAX_ACCOUNT_HISTORY_CHUNKS,
  planRotationHistoryRanges,
  shouldOfferManagedHandoffRetry,
} from '../src/lib/managed-pure';
import {
  buildRangerExitCalls,
  buildStrategyTokenRecoveryCalls,
  PANCAKE_POSITION_MANAGER_ABI,
  rangerExitMinimums,
} from '../src/lib/strategy-recovery-pure';
import {
  readBscQuorumAtCommonBlock,
  type BscPublicClient,
} from '../src/lib/bsc-public-client';

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

test('live destination validation accepts only exact EIP-7702 delegation markers', async () => {
  const wallet = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a';
  const delegation = '0xef0100612373d7003d694220f7800eeaf8e3924c0951d3';
  assert.equal(isEip7702Delegation(delegation), true);
  assert.equal(isEip7702Delegation(delegation.toUpperCase() as `0x${string}`), true);
  assert.equal(await destinationCodeProblem(wallet, async () => delegation), null);
  assert.equal(destinationCodeQuorumProblem([delegation, delegation, '0x6000']), null);
  assert.equal(isEip7702Delegation(`${delegation}00`), false);
  assert.match(await destinationCodeProblem(wallet, async () => `${delegation}00`) ?? '', /Contract destinations/);
});

test('Ranger owner recovery decreases bounded liquidity before collecting to the account', () => {
  const account = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(rangerExitMinimums([101n, 202n]), [90n, 181n]);
  const calls = buildRangerExitCalls({
    account,
    tokenId: 7271073n,
    liquidity: 1_000n,
    quotedExit: [101n, 202n],
    deadline: 1234n,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.to, PANCAKE_V3_POSITION_MANAGER);
  const decrease = decodeFunctionData({ abi: PANCAKE_POSITION_MANAGER_ABI, data: calls[0]!.data });
  assert.equal(decrease.functionName, 'decreaseLiquidity');
  assert.deepEqual(decrease.args?.[0], {
    tokenId: 7271073n,
    liquidity: 1_000n,
    amount0Min: 90n,
    amount1Min: 181n,
    deadline: 1234n,
  });
  const collect = decodeFunctionData({ abi: PANCAKE_POSITION_MANAGER_ABI, data: calls[1]!.data });
  assert.equal(collect.functionName, 'collect');
  assert.equal(collect.args?.[0].recipient.toLowerCase(), account.toLowerCase());
});

test('strategy recovery resets every pinned allowance before transferring live balances', () => {
  const destination = '0x2222222222222222222222222222222222222222';
  const calls = buildStrategyTokenRecoveryCalls('lp-range', destination, {
    WBNB: 7n,
    USDT: 11n,
    BTCB: 13n,
  });
  assert.equal(calls.length, 10);
  const approvals = calls.slice(0, 7).map((call) => ({
    to: call.to.toLowerCase(),
    decoded: decodeFunctionData({ abi: erc20Abi, data: call.data }),
  }));
  assert.deepEqual(approvals.map(({ decoded }) => decoded.functionName), [
    'approve', 'approve', 'approve', 'approve', 'approve', 'approve', 'approve',
  ]);
  assert.ok(approvals.every(({ decoded }) => decoded.args?.[1] === 0n));
  assert.ok(approvals.some(({ to, decoded }) =>
    to === TOKENS_BSC.WBNB!.address.toLowerCase()
    && decoded.args?.[0]?.toLowerCase() === OPHIS_VAULT_RELAYER_BSC.toLowerCase()));
  assert.ok(approvals.some(({ to, decoded }) =>
    to === TOKENS_BSC.USDT!.address.toLowerCase()
    && decoded.args?.[0]?.toLowerCase() === PANCAKE_V3_POSITION_MANAGER.toLowerCase()));
  const transfers = calls.slice(7).map((call) =>
    decodeFunctionData({ abi: erc20Abi, data: call.data }));
  assert.deepEqual(transfers.map((decoded) => decoded.functionName), ['transfer', 'transfer', 'transfer']);
  assert.deepEqual(transfers.map((decoded) => decoded.args), [
    [destination, 7n],
    [destination, 11n],
    [destination, 13n],
  ]);
});

test('security-sensitive BSC reads require matching independent responses at one block', async () => {
  const clients = [
    { answer: 'safe', getBlockNumber: async () => 100n },
    { answer: 'safe', getBlockNumber: async () => 102n },
    { answer: 'forged', getBlockNumber: async () => 101n },
  ] as unknown as BscPublicClient[];
  const blocks: bigint[] = [];
  const value = await readBscQuorumAtCommonBlock(async (client, blockNumber) => {
    blocks.push(blockNumber);
    return (client as unknown as { answer: string }).answer;
  }, String, { clients, quorum: 2 });
  assert.equal(value, 'safe');
  assert.deepEqual(blocks, [101n, 101n, 101n]);
  await assert.rejects(readBscQuorumAtCommonBlock(async (client) =>
    (client as unknown as { answer: string }).answer,
  String, { clients, quorum: 3 }), /unavailable or disagreed/);
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

test('runner status accepts only a successful service and positive numeric Ranger id', () => {
  assert.deepEqual(managedRunnerSnapshot({ service: 'ready', positionTokenId: '7271073' }, true), {
    service: 'ready',
    positionTokenId: '7271073',
    reachable: true,
  });
  assert.deepEqual(managedRunnerSnapshot({ service: 'ready', positionTokenId: '../wallet' }, true), {
    service: 'ready',
    positionTokenId: null,
    reachable: true,
  });
  assert.deepEqual(managedRunnerSnapshot({ service: 'ready', positionTokenId: '7271073' }, false), {
    service: 'unavailable',
    positionTokenId: null,
    reachable: false,
  });
});

test('a stale runner heartbeat cannot hide the exact Ranger NFT returned beside it', () => {
  assert.equal(effectiveManagedPositionTokenId({
    service: 'unavailable',
    positionTokenId: '7271073',
    reachable: true,
  }, null), '7271073');
  assert.equal(effectiveManagedPositionTokenId({
    service: 'unavailable',
    positionTokenId: null,
    reachable: false,
  }, '7271073'), '7271073');
  assert.equal(effectiveManagedPositionTokenId({
    service: 'unavailable',
    positionTokenId: null,
    reachable: true,
  }, '7271073'), null);
  assert.equal(effectiveManagedPositionTokenId({
    service: 'ready',
    positionTokenId: null,
    reachable: true,
  }, '7271073'), null);
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
