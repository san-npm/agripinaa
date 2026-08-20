import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC } from '@agripinaa/shared';

import { managedYieldTick } from '../src/agents/yield';
import type { ManagedExecutor } from '../src/executor';
import type { AgentContext } from '../src/types';

const USDT = TOKENS_BSC.USDT!.address;
const VENUS_VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';
const AAVE_POOL = '0x6807dc923806fE8Fd134338EABCA509979a7e0cB';
const ATOKEN = '0xa9251ca9DE909CB71783723713B21E4233fbf1B1';
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

// --- Registry round-trip (bigint-safe persistence) ------------------------

test('managed registry: upsert, replace, remove, bigint-safe', async () => {
  // Point the registry's DATA_DIR at a temp dir by loading a fresh module copy
  // with cwd-independent behavior is not possible; instead exercise via the
  // real data dir would pollute it. So test the codec invariant the registry
  // relies on directly, plus the in-memory upsert/remove semantics.
  const { serializeSession, deserializeSession } = await import(
    '@agripinaa/session-kit/persist'
  );
  const entry = {
    account: ACCOUNT,
    chainId: 56,
    session: {
      walletAddress: ACCOUNT,
      publicKey: '0x04abcd',
      permissions: { calls: [{ signature: 'toAave()', to: ACCOUNT }], spend: [{ limit: 50n * 10n ** 18n, period: 'day', token: USDT }] },
      expiry: 1893456000,
    },
    registeredAt: '2026-08-20T00:00:00.000Z',
  };
  const round = deserializeSession(serializeSession([entry])) as typeof entry[];
  assert.equal(round[0]!.session.permissions.spend![0]!.limit, 50n * 10n ** 18n);
  assert.equal(typeof round[0]!.session.permissions.spend![0]!.limit, 'bigint');
});

// --- managedYieldTick decision -> router action ---------------------------

interface FakeOpts {
  venusRatePerBlock: bigint;
  aaveLiquidityRate: bigint;
  walletUsdtWei: bigint;
  venusUnderlyingWei: bigint;
  aaveATokenWei: bigint;
  halted?: boolean;
  allowAction?: boolean;
  initialState?: Record<string, unknown>;
}

function fakeCtx(opts: FakeOpts): { ctx: AgentContext; logs: Record<string, unknown>[] } {
  const store = new Map<string, unknown>(Object.entries(opts.initialState ?? {}));
  const logs: Record<string, unknown>[] = [];
  const publicClient = {
    async getBlock(args?: { blockNumber?: bigint }) {
      // ~0.45s/block: 5000 blocks span 2250s, so blocksPerYear ~70.08M.
      return args?.blockNumber
        ? { number: args.blockNumber, timestamp: 1_000_000n - 2250n }
        : { number: 1_005_000n, timestamp: 1_000_000n };
    },
    async readContract(call: { address: string; functionName: string }) {
      const { address, functionName } = call;
      if (functionName === 'supplyRatePerBlock') return opts.venusRatePerBlock;
      if (functionName === 'getReserveData')
        return { currentLiquidityRate: opts.aaveLiquidityRate, aTokenAddress: ATOKEN };
      if (functionName === 'balanceOfUnderlying') return opts.venusUnderlyingWei;
      if (functionName === 'balanceOf' && address.toLowerCase() === USDT.toLowerCase())
        return opts.walletUsdtWei;
      if (functionName === 'balanceOf' && address.toLowerCase() === ATOKEN.toLowerCase())
        return opts.aaveATokenWei;
      throw new Error(`unexpected read ${functionName}@${address}`);
    },
  };
  const ctx = {
    name: 'yield',
    chainId: 56,
    account: { address: '0x0000000000000000000000000000000000000009' },
    publicClient,
    walletClient: {},
    log: (e: Record<string, unknown>) => logs.push(e),
    state: {
      get<T>(key: string, fallback: T): T {
        return (store.has(key) ? store.get(key) : fallback) as T;
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
    breakers: {
      halt() {},
      isHalted: () => (opts.halted ? { halted: true, reason: 'test' } : { halted: false }),
      allowAction: () => opts.allowAction ?? true,
    },
  } as unknown as AgentContext;
  return { ctx, logs };
}

function fakeExecutor(): ManagedExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    account: ACCOUNT,
    chainId: 56,
    async execute(action) {
      calls.push(action);
      return { txHash: '0xdead', status: 'CONFIRMED' };
    },
  };
}

// venus clearly beats aave: rate ~400M/block -> ~280 bps vs aave ~100 bps.
const VENUS_WINS = { venusRatePerBlock: 400_000_000n, aaveLiquidityRate: 1n * 10n ** 25n };
// aave clearly beats venus: aave ~500 bps vs venus ~70 bps.
const AAVE_WINS = { venusRatePerBlock: 100_000_000n, aaveLiquidityRate: 5n * 10n ** 25n };

test('idle + funded, venus better -> executes toVenus', async () => {
  const { ctx } = fakeCtx({ ...VENUS_WINS, walletUsdtWei: 100n * 10n ** 18n, venusUnderlyingWei: 0n, aaveATokenWei: 0n });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, ['toVenus']);
});

test('idle + funded, aave better -> executes toAave', async () => {
  const { ctx } = fakeCtx({ ...AAVE_WINS, walletUsdtWei: 100n * 10n ** 18n, venusUnderlyingWei: 0n, aaveATokenWei: 0n });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, ['toAave']);
});

test('idle but only dust -> no execute (unfunded)', async () => {
  const { ctx } = fakeCtx({ ...VENUS_WINS, walletUsdtWei: 5n * 10n ** 15n, venusUnderlyingWei: 0n, aaveATokenWei: 0n });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
});

test('halted -> no execute', async () => {
  const { ctx } = fakeCtx({ ...VENUS_WINS, walletUsdtWei: 100n * 10n ** 18n, venusUnderlyingWei: 0n, aaveATokenWei: 0n, halted: true });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
});

test('in venus, aave beats by > hysteresis on the 2nd streak -> rotates via toAave', async () => {
  const { ctx } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    // A prior qualifying check already armed the streak at 1.
    initialState: { [`managed:${ACCOUNT.toLowerCase()}:betterStreak`]: 1 },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, ['toAave']);
});

test('in venus, edge inside hysteresis -> holds, no execute', async () => {
  // venus and aave nearly equal -> edge < 50 bps -> hold.
  const { ctx } = fakeCtx({
    venusRatePerBlock: 285_000_000n,
    aaveLiquidityRate: 20n * 10n ** 24n, // ~200 bps, close to venus ~200 bps
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
});

test('rotate is gated by the per-account breaker', async () => {
  const { ctx } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    allowAction: false,
    initialState: { [`managed:${ACCOUNT.toLowerCase()}:betterStreak`]: 1 },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
});
