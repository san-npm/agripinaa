import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';
import { parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { buildManagedStrategyContext } from '../src/managed-strategy-runner';
import { ChassisOphisWallet } from '../src/ophis-wallet';
import type { AgentContext } from '../src/types';
import { canonicalStrategyPermissions } from '../src/x402-server';

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
    execute: async (opts: { session: { walletAddress: string }; calls: { to: string; data: string }[] }) => {
      assert.equal(opts.session.walletAddress, USER);
      call = opts.calls[0];
      return { status: 'CONFIRMED', transactionHash: `0x${'ab'.repeat(32)}` };
    },
  };
  const { base } = baseContext();
  const ctx = buildManagedStrategyContext({
    base,
    client: client as never,
    entry: entry() as never,
    managerKey: { privateKey: PRIVATE_KEY, address: manager.address, publicKey: manager.publicKey },
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
  ctx.breakers.halt('user drawdown');
  assert.deepEqual(ctx.breakers.isHalted(), { halted: true, reason: 'user drawdown' });
  assert.deepEqual(base.breakers.isHalted(), { halted: false });
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
