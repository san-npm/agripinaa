import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';
import { parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { managedAccountStateKey } from '../src/managed';
import {
  buildManagedStrategyContext,
  managedStrategyNextDelayMs,
  managedStrategySweepIntervalMs,
  readManagedRelayStatus,
} from '../src/managed-strategy-runner';
import { ChassisOphisWallet } from '../src/ophis-wallet';
import type { AgentContext } from '../src/types';
import { isGlobalHalt } from '../src/types';
import { canonicalStrategyPermissions, managedServiceHalt } from '../src/x402-server';

test('managed relay polling terminates off-chain failures and accepts confirmed receipts', async (t) => {
  const callsId = `0x${'12'.repeat(32)}` as const;
  const transactionHash = `0x${'34'.repeat(32)}` as const;
  let status = 100;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: {
    id: callsId, status, receipts: status < 200 ? [] : [{ transactionHash, status: '0x1' }],
  } }));
  assert.deepEqual(await readManagedRelayStatus({ callsId, chainId: 56 }), { status: 'PENDING' });
  for (status of [200, 201]) {
    assert.deepEqual(await readManagedRelayStatus({ callsId, chainId: 56 }), { status: 'CONFIRMED', transactionHash });
  }
  for (status of [300, 400, 500]) {
    assert.deepEqual(await readManagedRelayStatus({ callsId, chainId: 56 }), { status: 'FAILED' });
  }
});

const PRIVATE_KEY = `0x${'31'.repeat(32)}` as const;
const manager = privateKeyToAccount(PRIVATE_KEY);
const USER = '0x1111111111111111111111111111111111111111' as const;
const balanceOfAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

function baseContext(name = 'grid') {
  const values = new Map<string, unknown>();
  const base = {
    name,
    chainId: 56,
    publicClient: {} as never,
    state: {
      get<T>(key: string, fallback: T): T { return (values.has(key) ? values.get(key) : fallback) as T; },
      set(key: string, value: unknown) { values.set(key, value); },
    },
    breakers: { halt() {}, isHalted: () => ({ halted: false }), allowAction: () => true },
    log() {},
  } as unknown as AgentContext;
  return { base, values };
}

function entry() {
  return {
    account: USER,
    chainId: 56,
    session: {
      walletAddress: USER,
      publicKey: manager.publicKey,
      permissions: {
        calls: [{ to: TOKENS_BSC.USDT!.address, signature: 'balanceOf(address)' }],
        spend: [],
      },
      expiry: 1_900_000_000,
    },
    registeredAt: '2026-08-27T00:00:00.000Z',
  } as const;
}

test('managed context signs Ophis typed data as ERC-1271 for the user account', async () => {
  let signedFor = '';
  const client = {
    signOrderTypedData: async ({ session }: { session: { walletAddress: string } }) => {
      signedFor = session.walletAddress;
      return '0x1234';
    },
  };
  const { base } = baseContext();
  const ctx = buildManagedStrategyContext({
    base,
    client: client as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
  });
  const wallet = new ChassisOphisWallet(ctx.account, ctx.publicClient, ctx.walletClient);
  assert.equal(wallet.getAddress(), USER);
  assert.equal(wallet.getSigningScheme(), 'eip1271');
  assert.equal(await wallet.signTypedData({ domain: {}, types: {}, primaryType: 'Order', message: {} }), '0x1234');
  assert.equal(signedFor, USER);
});

test('managed writes are relayed through the exact stored session', async () => {
  let call: { to: string; data: string } | undefined;
  const client = {
    execute: async (opts: {
      session: { walletAddress: string };
      calls: { to: string; data: string }[];
      noWait?: boolean;
    }) => {
      assert.equal(opts.session.walletAddress, USER);
      assert.equal(opts.noWait, true);
      call = opts.calls[0];
      return { callsId: `0x${'cd'.repeat(32)}`, status: 'PENDING' };
    },
  };
  const { base } = baseContext();
  const ctx = buildManagedStrategyContext({
    base,
    client: client as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
    relayStatus: async () => ({
      status: 'CONFIRMED',
      transactionHash: `0x${'ab'.repeat(32)}`,
    }),
  });
  const hash = await ctx.walletClient.writeContract({
    address: TOKENS_BSC.USDT!.address,
    abi: balanceOfAbi,
    functionName: 'balanceOf',
    args: [USER],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });
  assert.equal(hash, `0x${'ab'.repeat(32)}`);
  assert.equal(call?.to, TOKENS_BSC.USDT!.address);
  assert.match(call?.data ?? '', /^0x70a08231/);
});

test('a relay-pending write is durably reconciled and never submitted twice', async () => {
  const callsId = `0x${'cd'.repeat(32)}` as const;
  const receipt = `0x${'ef'.repeat(32)}` as const;
  let executions = 0;
  let relayStatus: 'PENDING' | 'CONFIRMED' = 'PENDING';
  const client = {
    execute: async () => {
      executions += 1;
      return { callsId, status: 'PENDING' as const };
    },
  };
  const { base, values } = baseContext();
  const ctx = buildManagedStrategyContext({
    base,
    client: client as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
    relayStatus: async ({ callsId: checked }) => {
      assert.equal(checked, callsId);
      return relayStatus === 'CONFIRMED'
        ? { status: 'CONFIRMED', transactionHash: receipt }
        : { status: 'PENDING' };
    },
  });
  const write = () => ctx.walletClient.writeContract({
    address: TOKENS_BSC.USDT!.address,
    abi: balanceOfAbi,
    functionName: 'balanceOf',
    args: [USER],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });

  await assert.rejects(write, /still pending at the relay/);
  assert.equal(executions, 1);
  assert.equal(
    (values.get(managedAccountStateKey(USER, 'pendingRelayWrite')) as { callsId: string }).callsId,
    callsId,
  );

  await assert.rejects(write, /refusing to submit it twice/);
  assert.equal(executions, 1);

  relayStatus = 'CONFIRMED';
  assert.equal(await write(), receipt);
  assert.equal(executions, 1);
  assert.equal(values.get(managedAccountStateKey(USER, 'pendingRelayWrite')), null);
});

test('a confirmed relay receipt is never reused for different calldata', async () => {
  const callsId = `0x${'cd'.repeat(32)}` as const;
  const nextCallsId = `0x${'de'.repeat(32)}` as const;
  const oldReceipt = `0x${'ef'.repeat(32)}` as const;
  const newReceipt = `0x${'ab'.repeat(32)}` as const;
  let executions = 0;
  const client = {
    execute: async () => {
      executions += 1;
      return executions === 1
        ? { callsId, status: 'PENDING' as const }
        : { callsId: nextCallsId, status: 'PENDING' as const };
    },
  };
  let firstStatusRead = true;
  const { base } = baseContext();
  const ctx = buildManagedStrategyContext({
    base,
    client: client as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
    relayStatus: async ({ callsId: checked }) => {
      if (checked === nextCallsId) return { status: 'CONFIRMED', transactionHash: newReceipt };
      assert.equal(checked, callsId);
      if (firstStatusRead) {
        firstStatusRead = false;
        return { status: 'PENDING' };
      }
      return { status: 'CONFIRMED', transactionHash: oldReceipt };
    },
  });
  const write = (owner: `0x${string}`) => ctx.walletClient.writeContract({
    address: TOKENS_BSC.USDT!.address,
    abi: balanceOfAbi,
    functionName: 'balanceOf',
    args: [owner],
    account: ctx.account,
    chain: ctx.walletClient.chain,
  });

  await assert.rejects(() => write(USER), /still pending at the relay/);
  assert.equal(await write('0x2222222222222222222222222222222222222222'), newReceipt);
  assert.equal(executions, 2);
});

test('bounded batches still revisit every account inside the module cadence', () => {
  assert.equal(managedStrategySweepIntervalMs(60_000, 0), 60_000);
  assert.equal(managedStrategySweepIntervalMs(60_000, 100), 60_000);
  assert.equal(managedStrategySweepIntervalMs(60_000, 101), 30_000);
  assert.equal(managedStrategySweepIntervalMs(60_000, 300), 20_000);
  assert.equal(managedStrategySweepIntervalMs(120_000, 300), 40_000);
  assert.equal(managedStrategyNextDelayMs(60_000, 300, 5_000), 15_000);
  assert.equal(managedStrategyNextDelayMs(60_000, 300, 25_000), 0);
});

test('managed Aave guardian adopts a user position and never arms demo setup', () => {
  const { base, values } = baseContext('health-factor');
  buildManagedStrategyContext({
    base,
    client: {} as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
  });
  assert.equal(values.get(`managed:${USER.toLowerCase()}:setupDone`), true);
});

test('managed breaker state is isolated from the own-capital account', () => {
  const { base } = baseContext('grid');
  const ctx = buildManagedStrategyContext({
    base,
    client: {} as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
  });
  ctx.breakers.halt('user drawdown', { global: false });
  assert.deepEqual(ctx.breakers.isHalted(), { halted: true, reason: 'user drawdown', global: false });
  assert.deepEqual(base.breakers.isHalted(), { halted: false });
});

test('a managed shared-integrity halt propagates to the global breaker', () => {
  const { base } = baseContext('lp-range');
  let globalHalt: { reason: string; global: boolean } | null = null;
  base.breakers.halt = (reason, scope) => {
    globalHalt = { reason, global: scope?.global === true };
  };
  base.breakers.isHalted = () => globalHalt
    ? { halted: true, reason: globalHalt.reason, global: globalHalt.global }
    : { halted: false };
  const ctx = buildManagedStrategyContext({
    base,
    client: {} as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
  });

  ctx.breakers.halt('position manager factory mismatch', { global: true });
  assert.deepEqual(globalHalt, { reason: 'position manager factory mismatch', global: true });
  assert.deepEqual(ctx.breakers.isHalted(), {
    halted: true,
    reason: 'position manager factory mismatch',
    global: true,
  });
});

test('managed strategy status reads the account breaker, not the demo-wallet breaker', () => {
  const { base, values } = baseContext('grid');
  base.breakers.isHalted = () => ({ halted: true, reason: 'demo drawdown', global: false });
  assert.deepEqual(managedServiceHalt('grid', USER, base), { halted: false });

  values.set(managedAccountStateKey(USER, 'halted'), { reason: 'user drawdown' });
  assert.deepEqual(managedServiceHalt('grid', USER, base), {
    halted: true,
    reason: 'user drawdown',
  });

  const yieldContext = { ...base, name: 'yield' } as AgentContext;
  assert.deepEqual(managedServiceHalt('yield', USER, yieldContext), {
    halted: true,
    reason: 'demo drawdown',
    global: false,
  });
});

test('global and legacy fail-closed halts still stop every managed account', () => {
  const { base } = baseContext('grid');
  base.breakers.isHalted = () => ({ halted: true, reason: 'state-file-corrupt', global: true });
  assert.deepEqual(managedServiceHalt('grid', USER, base), {
    halted: true,
    reason: 'state-file-corrupt',
    global: true,
  });
  assert.equal(isGlobalHalt({ halted: true, reason: 'legacy operator halt' }), true);
  assert.equal(isGlobalHalt({ halted: true, reason: 'demo drawdown', global: false }), false);
});

test('Ranger handoff requires the WBNB ceiling that makes direct mint executable', () => {
  const policy = canonicalStrategyPermissions('lp-range');
  assert.ok(policy);
  assert.deepEqual(policy.spend, [
    {
      token: TOKENS_BSC.USDT!.address,
      period: 'day',
      limit: toBaseUnits('1000000', TOKENS_BSC.USDT!.decimals),
    },
    {
      token: TOKENS_BSC.WBNB!.address,
      period: 'day',
      limit: toBaseUnits('100', TOKENS_BSC.WBNB!.decimals),
    },
    { period: 'day', limit: toBaseUnits('0.005', 18) },
  ]);
});
