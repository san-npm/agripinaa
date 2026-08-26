import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKENS_BSC, YIELD_ROUTER_BSC, YIELD_ROUTER_BSC_USDC } from '@agripinaa/shared';
import { padHex, toEventSelector } from 'viem';

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

test('public manage records are rebuilt from canonical policy and strip unknown permissions', async () => {
  const { canonicalManagedSession } = await import('../src/x402-server');
  const publicKey = `0x04${'ab'.repeat(64)}` as const;
  const canonical = canonicalManagedSession(ACCOUNT, 1_893_456_000, YIELD_ROUTER_BSC, publicKey);
  assert.deepEqual(Object.keys(canonical.permissions).sort(), ['calls', 'spend']);
  assert.deepEqual(
    canonical.permissions.calls?.map((call) => 'signature' in call ? call.signature : null),
    ['toAave()', 'toVenus()', 'toIdle()'],
  );
  assert.equal('unvalidated' in canonical.permissions, false);
});

test('managed enrollment rejects expiry beyond the bounded grant lifetime', async () => {
  const { managedExpiryProblem } = await import('../src/x402-server');
  const now = 1_900_000_000;
  assert.equal(managedExpiryProblem(now + 30 * 24 * 60 * 60, now), null);
  assert.equal(managedExpiryProblem(now + 30 * 24 * 60 * 60 + 5 * 60, now), null);
  assert.match(managedExpiryProblem(now + 31 * 24 * 60 * 60, now) ?? '', /30-day/);
  assert.match(managedExpiryProblem(now, now) ?? '', /expired/);
});

test('managed health stays unavailable after a terminal execution failure until a write recovers', async () => {
  const { healthAfterManagedTick } = await import('../src/managed-runner');
  const failed = healthAfterManagedTick(null, 'FAILED', 100);
  assert.deepEqual(failed, {
    at: 100,
    result: 'error',
    reason: 'the latest managed execution failed',
    requiresExecutionRecovery: true,
  });
  assert.deepEqual(healthAfterManagedTick(failed, undefined, 200), { ...failed, at: 200 });
  assert.deepEqual(healthAfterManagedTick(failed, 'CONFIRMED', 300), { at: 300, result: 'ready' });
  assert.deepEqual(
    healthAfterManagedTick({ at: 300, result: 'ready' }, undefined, 400, 'pending transaction reverted'),
    { at: 400, result: 'error', reason: 'pending transaction reverted', requiresExecutionRecovery: true },
  );
  assert.deepEqual(
    healthAfterManagedTick({ at: 450, result: 'error', reason: 'temporary RPC failure' }, undefined, 500),
    { at: 500, result: 'ready' },
  );
});

test('managed sweeps are bounded and round-robin reaches the tail', async () => {
  const { managedSweepBatch } = await import('../src/managed-runner');
  const all = Array.from({ length: 205 }, (_, index) => index);
  let cursor = 0;
  const seen: number[] = [];
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const batch = managedSweepBatch(all, cursor, 100);
    assert.ok(batch.entries.length <= 100);
    seen.push(...batch.entries);
    cursor = batch.nextCursor;
  }
  assert.equal(new Set(seen).size, all.length);
  assert.equal(seen.includes(204), true);
});

test('a full registry is revisited before its health heartbeat becomes stale', async () => {
  const { MAX_MANAGED_ENTRIES_PER_SWEEP } = await import('../src/managed-runner');
  const { MANAGED_HEALTH_MAX_AGE_MS, MAX_MANAGED_ENTRIES_PER_AGENT } = await import('../src/managed');
  const defaultSweepIntervalMs = 5 * 60 * 1000;
  const revisitMs = Math.ceil(MAX_MANAGED_ENTRIES_PER_AGENT / MAX_MANAGED_ENTRIES_PER_SWEEP)
    * defaultSweepIntervalMs;
  assert.ok(revisitMs < MANAGED_HEALTH_MAX_AGE_MS);
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

test('managedExecutor refuses a debt-incomplete router even when its manager key matches', async () => {
  const { managedExecutor, deploymentForEntry, recoveryDeploymentForEntry } = await import('../src/executor');
  const { privateKeyToAccount } = await import('viem/accounts');
  const grantedPk = `0x${'22'.repeat(32)}` as const;
  const granted = privateKeyToAccount(grantedPk);
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
  assert.equal(recoveryDeploymentForEntry(entry as never)?.symbol, 'USDT');
  assert.equal(deploymentForEntry(entry as never), undefined);
  // The currently deployed v2 router does not cover the Venus VAI debt
  // ledger. No session targeting it may reach the relay, including a session
  // whose manager key is otherwise valid.
  assert.throws(
    () => managedExecutor({ client: {} as never, managerKey: grantedPk, entry: entry as never }),
    /no YieldRouter/,
  );
});

test('token-driven selection also refuses the debt-incomplete USDC deployment', async () => {
  // Simulates a STALE pre-fix grant: a USDC-router-scoped session that was
  // (wrongly) authorized against the USDT master key. Runner selection is
  // token-driven, so it picks the USDC key; the executor assert then rejects it
  // because the USDC key's public key != the session's (USDT) public key.
  const { managedExecutor, deploymentForEntry, recoveryDeploymentForEntry } = await import('../src/executor');
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
  // Metadata still resolves for recovery, but the runner does not admit the
  // v2 deployment for automated execution.
  assert.equal(recoveryDeploymentForEntry(staleEntry as never)?.symbol, 'USDC');
  assert.equal(deploymentForEntry(staleEntry as never), undefined);
  assert.throws(
    () => managedExecutor({ client: {} as never, managerKey: usdcKey.privateKey, entry: staleEntry as never }),
    /no YieldRouter/,
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
  receiptStatus?: 'success' | 'reverted';
  receiptEncumbered?: boolean;
}

function fakeCtx(opts: FakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
  released: string[];
} {
  const store = new Map<string, unknown>(Object.entries(opts.initialState ?? {}));
  const logs: Record<string, unknown>[] = [];
  const released: string[] = [];
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
    async getTransactionReceipt() {
      if (!opts.receiptStatus) throw new Error('not found');
      return {
        status: opts.receiptStatus,
        logs: opts.receiptEncumbered ? [{
          address: YIELD_ROUTER_BSC.address,
          topics: [
            toEventSelector('EncumberedPositionSkipped(address,address,address,uint256)'),
            padHex(ACCOUNT, { size: 32 }),
            padHex(ATOKEN, { size: 32 }),
            padHex(ATOKEN, { size: 32 }),
          ],
        }] : [],
      };
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
      releaseAction: (kind: string) => released.push(kind),
    },
  } as unknown as AgentContext;
  return { ctx, logs, store, released };
}

function fakeExecutor(status: 'PENDING' | 'CONFIRMED' | 'FAILED' = 'CONFIRMED'): ManagedExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    account: ACCOUNT,
    chainId: 56,
    deployment: YIELD_ROUTER_BSC,
    async execute(action) {
      calls.push(action);
      return { txHash: '0xdead', status };
    },
  };
}

function rejectingExecutor(): ManagedExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    account: ACCOUNT,
    chainId: 56,
    deployment: YIELD_ROUTER_BSC,
    async execute(action) {
      calls.push(action);
      throw new Error('relay transport failed');
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

test('failed or pending entry does not claim the target venue', async () => {
  for (const status of ['FAILED', 'PENDING'] as const) {
    const { ctx, store, logs } = fakeCtx({
      ...AAVE_WINS,
      walletUsdtWei: 100n * 10n ** 18n,
      venusUnderlyingWei: 0n,
      aaveATokenWei: 0n,
    });
    await managedYieldTick(ctx, fakeExecutor(status));
    assert.equal(store.get(`managed:${ACCOUNT.toLowerCase()}:USDT:venue`), undefined);
    assert.equal(
      store.get(`managed:${ACCOUNT.toLowerCase()}:USDT:pendingTarget`),
      status === 'PENDING' ? 'aave' : undefined,
    );
    assert.equal(
      store.get(`managed:${ACCOUNT.toLowerCase()}:USDT:pendingKind`),
      status === 'PENDING' ? 'relay-pending' : undefined,
    );
    assert.equal(logs.at(-1)?.['decision'], status === 'FAILED' ? 'enter-failed' : 'enter-pending');
  }
});

test('a thrown entry execution releases its breaker reservation', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store, released } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 100n * 10n ** 18n,
    venusUnderlyingWei: 0n,
    aaveATokenWei: 0n,
  });
  await assert.rejects(managedYieldTick(ctx, rejectingExecutor()), /relay transport failed/);
  assert.deepEqual(released, [`${key}enter`]);
  assert.equal(store.get(`${key}pendingTarget`), undefined);
});

test('confirmed entry waits for a fresh chain read before claiming the target venue', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store, logs } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 100n * 10n ** 18n,
    venusUnderlyingWei: 0n,
    aaveATokenWei: 0n,
  });
  await managedYieldTick(ctx, fakeExecutor('CONFIRMED'));
  assert.equal(store.get(`${key}venue`), undefined);
  assert.equal(store.get(`${key}pendingTarget`), 'aave');
  assert.equal(store.get(`${key}pendingKind`), 'confirmed-reconcile');
  assert.equal(logs.at(-1)?.['decision'], 'enter-confirmed-awaiting-chain');
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

test('failed rotation restores cooldown, streak, and breaker reservation', async () => {
  const oldRotate = Date.now() - 86_400_000;
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store, logs, released } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    initialState: {
      [`${key}betterStreak`]: 1,
      [`${key}lastRotateAt`]: oldRotate,
    },
  });
  await managedYieldTick(ctx, fakeExecutor('FAILED'));
  assert.equal(store.get(`${key}venue`), 'venus');
  assert.equal(store.get(`${key}lastRotateAt`), oldRotate);
  assert.equal(store.get(`${key}betterStreak`), 1);
  assert.deepEqual(released, [`${key}rotate`]);
  assert.equal(logs.at(-1)?.['decision'], 'rotate-failed');
});

test('a thrown rotation restores cooldown, streak, and breaker reservation', async () => {
  const oldRotate = Date.now() - 86_400_000;
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store, released } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    initialState: {
      [`${key}betterStreak`]: 1,
      [`${key}lastRotateAt`]: oldRotate,
    },
  });
  await assert.rejects(managedYieldTick(ctx, rejectingExecutor()), /relay transport failed/);
  assert.equal(store.get(`${key}lastRotateAt`), oldRotate);
  assert.equal(store.get(`${key}betterStreak`), 1);
  assert.deepEqual(released, [`${key}rotate`]);
});

test('pending rotation keeps the cooldown but does not claim success', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store, logs } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    initialState: { [`${key}betterStreak`]: 1 },
  });
  await managedYieldTick(ctx, fakeExecutor('PENDING'));
  assert.equal(store.get(`${key}venue`), 'venus');
  assert.equal(typeof store.get(`${key}lastRotateAt`), 'number');
  assert.equal(store.get(`${key}pendingTarget`), 'aave');
  assert.equal(store.get(`${key}pendingKind`), 'relay-pending');
  assert.equal(logs.at(-1)?.['decision'], 'rotate-pending');
});

test('an unresolved pending rotation blocks every later write', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'relay-pending',
      [`${key}pendingAt`]: Date.now(),
    },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
  assert.equal(logs.at(-1)?.['decision'], 'pending-awaiting-chain');
});

test('a reverted pending receipt reports unhealthy and restores rotation policy anchors', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store, released } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    receiptStatus: 'reverted',
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'relay-pending',
      [`${key}pendingActionKind`]: 'rotate',
      [`${key}pendingAt`]: Date.now(),
      [`${key}pendingTxHash`]: `0x${'12'.repeat(32)}`,
      [`${key}lastRotateAt`]: 999,
      [`${key}betterStreak`]: 0,
      [`${key}pendingPreviousLastRotateAt`]: 123,
      [`${key}pendingPreviousBetterStreak`]: 1,
    },
  });
  const outcome = await managedYieldTick(ctx, fakeExecutor());
  assert.equal(outcome?.health, 'error');
  assert.match(outcome?.reason ?? '', /reverted/);
  assert.equal(store.get(`${key}lastRotateAt`), 123);
  assert.equal(store.get(`${key}betterStreak`), 1);
  assert.deepEqual(released, [`${key}rotate`]);
});

test('an unproven source-majority split is surfaced without inventing sticky debt state', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 60n * 10n ** 18n,
    aaveATokenWei: 40n * 10n ** 18n,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'confirmed-reconcile',
      [`${key}pendingActionKind`]: 'rotate',
      [`${key}lastRotateAt`]: 999,
      [`${key}betterStreak`]: 0,
      [`${key}pendingPreviousLastRotateAt`]: 123,
      [`${key}pendingPreviousBetterStreak`]: 1,
    },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
  assert.equal(store.get(`${key}pendingTarget`), null);
  assert.equal(store.get(`${key}lastRotateAt`), 999);
  assert.equal(store.get(`${key}betterStreak`), 1);
  assert.notEqual(store.get(`${key}splitBlocked`), true);
  assert.equal(logs.filter((log) => log['decision'] === 'pending-confirmed-split-observed').length, 1);
  assert.equal(logs.some((log) => log['reason'] === 'partial-debt-blocked'), false);
});

test('a target-majority split confirms an included execution instead of claiming debt blockage', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 40n * 10n ** 18n,
    aaveATokenWei: 60n * 10n ** 18n,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'confirmed-reconcile',
      [`${key}pendingActionKind`]: 'rotate',
    },
  });
  await managedYieldTick(ctx, fakeExecutor());
  assert.equal(store.get(`${key}pendingTarget`), null);
  assert.equal(store.get(`${key}venue`), 'aave');
  assert.equal(logs.at(-1)?.['decision'], 'pending-confirmed');
  assert.equal(logs.some((log) => log['reason'] === 'partial-debt-blocked'), false);
});

test('an encumbered receipt log persists and retries a target-majority partial after cooldown', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 49n * 10n ** 18n,
    aaveATokenWei: 51n * 10n ** 18n,
    receiptStatus: 'success',
    receiptEncumbered: true,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'confirmed-reconcile',
      [`${key}pendingActionKind`]: 'rotate',
      [`${key}pendingAt`]: Date.now(),
      [`${key}pendingTxHash`]: `0x${'34'.repeat(32)}`,
    },
  });
  const executor = fakeExecutor();
  await managedYieldTick(ctx, executor);
  assert.equal(store.get(`${key}partialTarget`), 'aave');
  assert.equal(logs.at(-1)?.['reason'], 'partial-debt-blocked');

  // Debt repayment does not itself move either receipt balance. Once the
  // bounded retry interval elapses, the runner must call the target again so
  // the formerly encumbered source is consolidated.
  store.set(`${key}partialLastAttemptAt`, Date.now() - 25 * 60 * 60 * 1000);
  await managedYieldTick(ctx, executor);
  assert.deepEqual(executor.calls, ['toAave']);
  assert.equal(store.get(`${key}pendingActionKind`), 'partial');
});

test('failed and thrown partial retries restore their cooldown and breaker reservation', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const previousAttempt = Date.now() - 25 * 60 * 60 * 1000;
  for (const [executor, shouldThrow] of [
    [fakeExecutor('FAILED'), false],
    [rejectingExecutor(), true],
  ] as const) {
    const { ctx, store, released } = fakeCtx({
      ...AAVE_WINS,
      walletUsdtWei: 0n,
      venusUnderlyingWei: 49n * 10n ** 18n,
      aaveATokenWei: 51n * 10n ** 18n,
      initialState: {
        [`${key}partialTarget`]: 'aave',
        [`${key}partialLastAttemptAt`]: previousAttempt,
      },
    });
    if (shouldThrow) await assert.rejects(managedYieldTick(ctx, executor), /relay transport failed/);
    else await managedYieldTick(ctx, executor);
    assert.equal(store.get(`${key}partialLastAttemptAt`), previousAttempt);
    assert.deepEqual(released, [`${key}rotate`]);
  }
});

test('an encumbered no-move receipt keeps its retry target while all funds remain at the source', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    receiptStatus: 'success',
    receiptEncumbered: true,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'confirmed-reconcile',
      [`${key}pendingActionKind`]: 'rotate',
      [`${key}pendingAt`]: Date.now(),
      [`${key}pendingTxHash`]: `0x${'56'.repeat(32)}`,
    },
  });
  const executor = fakeExecutor();
  await managedYieldTick(ctx, executor);
  assert.equal(store.get(`${key}partialTarget`), 'aave');
  await managedYieldTick(ctx, executor);
  assert.equal(store.get(`${key}partialTarget`), 'aave');
  assert.deepEqual(executor.calls, []);
  store.set(`${key}partialLastAttemptAt`, Date.now() - 25 * 60 * 60 * 1000);
  await managedYieldTick(ctx, executor);
  assert.deepEqual(executor.calls, ['toAave']);
});

test('a split cannot clear an unresolved relay-pending transaction', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 60n * 10n ** 18n,
    aaveATokenWei: 40n * 10n ** 18n,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'relay-pending',
      [`${key}pendingAt`]: Date.now(),
    },
  });
  await managedYieldTick(ctx, fakeExecutor());
  assert.equal(store.get(`${key}pendingTarget`), 'aave');
  assert.equal(logs.at(-1)?.['decision'], 'pending-awaiting-chain');
  assert.equal(logs.some((log) => log['reason'] === 'partial-debt-blocked'), false);
});

test('a raw split receipt donation does not freeze a mandate without a pending execution', async () => {
  const { ctx, logs, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 40n * 10n ** 18n,
    aaveATokenWei: 60n * 10n ** 18n,
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, []);
  assert.notEqual(store.get(`managed:${ACCOUNT.toLowerCase()}:USDT:splitBlocked`), true);
  assert.equal(logs.some((log) => log['reason'] === 'partial-debt-blocked'), false);
});

test('a confirmed no-op clears reconciliation and releases its breaker slot', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs, store, released } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'confirmed-reconcile',
      [`${key}pendingActionKind`]: 'rotate',
      [`${key}lastRotateAt`]: 999,
      [`${key}betterStreak`]: 0,
      [`${key}pendingPreviousLastRotateAt`]: 123,
      [`${key}pendingPreviousBetterStreak`]: 1,
    },
  });
  await managedYieldTick(ctx, fakeExecutor());
  assert.equal(store.get(`${key}pendingTarget`), null);
  assert.equal(store.get(`${key}lastRotateAt`), 123);
  assert.equal(store.get(`${key}betterStreak`), 1);
  assert.deepEqual(released, [`${key}rotate`]);
  assert.equal(logs.at(-1)?.['decision'], 'confirmed-no-state-change');
});

test('a stale unresolved relay expires unhealthy instead of locking the mandate forever', async () => {
  const key = `managed:${ACCOUNT.toLowerCase()}:USDT:`;
  const { ctx, logs, store } = fakeCtx({
    ...AAVE_WINS,
    walletUsdtWei: 0n,
    venusUnderlyingWei: 100n * 10n ** 18n,
    aaveATokenWei: 0n,
    initialState: {
      [`${key}pendingTarget`]: 'aave',
      [`${key}pendingKind`]: 'relay-pending',
      [`${key}pendingAt`]: Date.now() - 36 * 60 * 1000,
    },
  });
  const outcome = await managedYieldTick(ctx, fakeExecutor());
  assert.equal(store.get(`${key}pendingTarget`), null);
  assert.equal(logs.at(-1)?.['decision'], 'pending-expired');
  assert.equal(outcome?.health, 'error');
});
