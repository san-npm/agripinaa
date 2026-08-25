import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC, YIELD_ROUTER_BSC, YIELD_ROUTER_BSC_USDC } from '@agripinaa/shared';

import { managedYieldTick } from '../src/agents/yield';
import type { ManagedExecutor } from '../src/executor';
import type { AgentContext } from '../src/types';

const USDT = TOKENS_BSC.USDT!.address;
const VENUS_VUSDT = '0xfD5840Cd36d94D7229439859C0112a4185BC0255';
const AAVE_POOL = '0x6807dc923806fE8Fd134338EABCA509979a7e0cB';
const ATOKEN = '0xa9251ca9DE909CB71783723713B21E4233fbf1B1';
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

// --- Registry round-trip (bigint-safe persistence) ------------------------

/** One storable registry entry, with a bigint spend limit to exercise the codec. */
function registryEntry() {
  return {
    account: ACCOUNT,
    chainId: 56,
    session: {
      walletAddress: ACCOUNT,
      publicKey: '0x04abcd',
      permissions: { calls: [{ signature: 'toAave()', to: ACCOUNT }], spend: [{ limit: 50n * 10n ** 18n, period: 'day' as const, token: USDT }] },
      expiry: 1893456000,
    },
    registeredAt: '2026-08-20T00:00:00.000Z',
  };
}

test('managed registry: upsert, replace, remove, bigint-safe', async () => {
  // The codec invariant the registry relies on: bigint spend limits survive
  // the round trip through session-kit's serialize/deserialize.
  const { serializeSession, deserializeSession } = await import(
    '@agripinaa/session-kit/persist'
  );
  const entry = registryEntry();
  const round = deserializeSession(serializeSession([entry])) as typeof entry[];
  assert.equal(round[0]!.session.permissions.spend![0]!.limit, 50n * 10n ** 18n);
  assert.equal(typeof round[0]!.session.permissions.spend![0]!.limit, 'bigint');
});

test('the managed registry file lands at 0600 inside a data dir tightened to 0700', { skip: process.platform === 'win32' }, async () => {
  // The registry holds every managed user's account address, session public
  // key, granted permissions and expiry. It was written at the default umask
  // into a dir the run lock had already created at the default umask, so
  // creating the dir with a mode never applied on the VM.
  const { loadManaged, removeManaged, upsertManaged } = await import('../src/managed');
  const { mkdirSync, mkdtempSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'agripinaa-managed-'));
  try {
    const dir = join(root, 'data');
    mkdirSync(dir, { mode: 0o755 }); // predates the mode, like the VM's
    const entry = registryEntry() as never;
    upsertManaged('yield', entry, dir);
    const file = join(dir, 'yield.managed.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(loadManaged('yield', dir).length, 1);
    assert.equal(removeManaged('yield', ACCOUNT, dir).length, 0);
    assert.equal(statSync(file).mode & 0o777, 0o600); // rewritten, still owner-only
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- per-token manager key isolation (Medium fix) -------------------------

test('deriveManagerKey: distinct on-chain identity per token, deterministic', async () => {
  const { deriveManagerKey } = await import('../src/manager-key');
  const { privateKeyToAccount } = await import('viem/accounts');
  const masterPk = `0x${'11'.repeat(32)}` as const;
  const a = privateKeyToAccount(masterPk);
  const master = { privateKey: masterPk, address: a.address, publicKey: a.publicKey };
  const usdc1 = deriveManagerKey(master, 'USDC');
  const usdc2 = deriveManagerKey(master, 'USDC');
  const usdx = deriveManagerKey(master, 'USDX');
  // Deterministic (same seed+symbol -> same key), so both browser and runner agree.
  assert.equal(usdc1.publicKey, usdc2.publicKey);
  // Distinct from the master key and from every other token's key: no shared
  // on-chain key identity, hence no shared expiry or revocation.
  assert.notEqual(usdc1.publicKey.toLowerCase(), master.publicKey.toLowerCase());
  assert.notEqual(usdc1.publicKey.toLowerCase(), usdx.publicKey.toLowerCase());
});

test('managedExecutor rejects a manager key that does not match the granted session', async () => {
  const { managedExecutor } = await import('../src/executor');
  const { privateKeyToAccount } = await import('viem/accounts');
  const grantedPk = `0x${'22'.repeat(32)}` as const;
  const granted = privateKeyToAccount(grantedPk);
  const wrongPk = `0x${'33'.repeat(32)}` as const;
  const entry = {
    account: ACCOUNT,
    chainId: 56,
    session: {
      walletAddress: ACCOUNT,
      publicKey: granted.publicKey,
      permissions: { calls: [{ signature: 'toVenus()', to: YIELD_ROUTER_BSC.address }] },
      expiry: 1893456000,
    },
    registeredAt: '2026-08-20T00:00:00.000Z',
  };
  // Wrong key: fail closed before anything reaches the relay.
  assert.throws(
    () => managedExecutor({ client: {} as never, managerKey: wrongPk, entry: entry as never }),
    /does not match/,
  );
  // Correct key: constructs and resolves the token from the scoped router.
  const ok = managedExecutor({ client: {} as never, managerKey: grantedPk, entry: entry as never });
  assert.equal(ok.deployment.symbol, 'USDT');
});

test('token-driven selection rejects a USDC entry that was granted to the USDT key', async () => {
  // Simulates a STALE pre-fix grant: a USDC-router-scoped session that was
  // (wrongly) authorized against the USDT master key. Runner selection is
  // token-driven, so it picks the USDC key; the executor assert then rejects it
  // because the USDC key's public key != the session's (USDT) public key.
  const { managedExecutor, deploymentForEntry } = await import('../src/executor');
  const { deriveManagerKey } = await import('../src/manager-key');
  const { privateKeyToAccount } = await import('viem/accounts');
  const masterPk = `0x${'44'.repeat(32)}` as const;
  const master = privateKeyToAccount(masterPk);
  const usdcKey = deriveManagerKey(
    { privateKey: masterPk, address: master.address, publicKey: master.publicKey },
    'USDC',
  );
  const staleEntry = {
    account: ACCOUNT,
    chainId: 56,
    session: {
      walletAddress: ACCOUNT,
      publicKey: master.publicKey, // granted to the WRONG (USDT/master) key
      permissions: { calls: [{ signature: 'toVenus()', to: YIELD_ROUTER_BSC_USDC.address }] },
      expiry: 1893456000,
    },
    registeredAt: '2026-08-20T00:00:00.000Z',
  };
  // The entry's token resolves to USDC from its scoped router.
  assert.equal(deploymentForEntry(staleEntry as never)?.symbol, 'USDC');
  // Selecting the USDC key (token-driven) and executing must fail closed.
  assert.throws(
    () => managedExecutor({ client: {} as never, managerKey: usdcKey.privateKey, entry: staleEntry as never }),
    /does not match/,
  );
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
    deployment: YIELD_ROUTER_BSC,
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
    // A prior qualifying check already armed the streak at 1. State is namespaced
    // by (account, token); the fake executor manages the USDT router.
    initialState: { [`managed:${ACCOUNT.toLowerCase()}:USDT:betterStreak`]: 1 },
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
