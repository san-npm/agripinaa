/**
 * yield-b exists to make funds under management a choice rather than a feature:
 * two agents on the same un-owned router, same venues, same reads, different
 * policies. So the tests that matter are the comparative ones, and most of this
 * file runs BOTH agents' policies through the shared managed tick on identical
 * inputs and asserts they disagree in the direction the manifest claims.
 *
 * The two gates are exercised separately on purpose. A conservative agent that
 * only ever held because of its threshold, or only ever because of its
 * confirmation count, would be one gate wearing two names.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, AGENT_LIST, TOKENS_BSC, YIELD_ROUTER_BSC, toBaseUnits } from '@agripinaa/shared';

import { managerKeyFile } from '../src/manager-key';
import {
  HYSTERESIS_BPS,
  REQUIRED_STREAK,
  managedYieldTick,
  yieldAgent,
} from '../src/agents/yield';
import { YIELD_B_PARAMS, shouldRotate, yieldBAgent } from '../src/agents/yield-b';
import { YIELD_B_POLICY, conservativeRotation, policyForAgent } from '../src/yield-policy';
import type { ManagedExecutor } from '../src/executor';
import type { AgentContext } from '../src/types';

const USDT = TOKENS_BSC['USDT']!;
const ATOKEN = '0xa9251ca9DE909CB71783723713B21E4233fbf1B1';
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const DAY_MS = 24 * 3600 * 1000;

/* ------------------------------ the predicate ---------------------------- */

test('is more conservative than the existing harvester', () => {
  assert.ok(YIELD_B_PARAMS.thresholdBps > HYSTERESIS_BPS, 'wider threshold than yield');
  assert.ok(YIELD_B_PARAMS.requiredWins > REQUIRED_STREAK, 'more confirmations than yield');
  assert.ok(
    yieldBAgent.tickIntervalMs > yieldAgent.tickIntervalMs,
    'checks less often than yield',
  );
  assert.equal(YIELD_B_PARAMS.thresholdBps, 120);
  assert.equal(YIELD_B_PARAMS.requiredWins, 3);
  assert.equal(YIELD_B_PARAMS.minRotationIntervalMs, 2 * DAY_MS);
});

test('holds when the rival lead is inside the threshold', () => {
  assert.equal(
    shouldRotate({
      currentApyBps: 200,
      rivalApyBps: 240,
      thresholdBps: 100,
      consecutiveWins: 9,
      requiredWins: 3,
    }),
    false,
  );
});

test('holds when the lead is big but unconfirmed', () => {
  assert.equal(
    shouldRotate({
      currentApyBps: 200,
      rivalApyBps: 400,
      thresholdBps: 100,
      consecutiveWins: 1,
      requiredWins: 3,
    }),
    false,
  );
});

test('rotates on a confirmed lead beyond the threshold', () => {
  assert.equal(
    shouldRotate({
      currentApyBps: 200,
      rivalApyBps: 400,
      thresholdBps: 100,
      consecutiveWins: 3,
      requiredWins: 3,
    }),
    true,
  );
});

test('a lead going the wrong way never rotates, however long it holds', () => {
  assert.equal(
    shouldRotate({
      currentApyBps: 400,
      rivalApyBps: 200,
      thresholdBps: 100,
      consecutiveWins: 50,
      requiredWins: 3,
    }),
    false,
  );
});

/* --------------------------- the streak machine -------------------------- */

test('the streak arms one check at a time and rotates on the third', () => {
  const rates = { venue: 'venus' as const, venusBps: 200, aaveBps: 400 };
  const first = conservativeRotation({ ...rates, betterStreak: 0 });
  assert.equal(first.action, 'hold');
  assert.equal(first.nextStreak, 1);
  const second = conservativeRotation({ ...rates, betterStreak: first.nextStreak });
  assert.equal(second.action, 'hold');
  assert.equal(second.nextStreak, 2);
  const third = conservativeRotation({ ...rates, betterStreak: second.nextStreak });
  assert.equal(third.action, 'rotate');
  assert.equal(third.target, 'aave');
  assert.equal(third.nextStreak, 0);
});

test('one check inside the threshold resets the whole streak', () => {
  // Two confirmations then a quiet check puts the count back to zero, so a
  // brief spike cannot accumulate toward a rotation across a calm week.
  const armed = conservativeRotation({ venue: 'venus', venusBps: 200, aaveBps: 400, betterStreak: 2 });
  assert.equal(armed.action, 'rotate');
  const lapsed = conservativeRotation({ venue: 'venus', venusBps: 200, aaveBps: 260, betterStreak: 2 });
  assert.equal(lapsed.action, 'hold');
  assert.equal(lapsed.nextStreak, 0);
});

test('the streak machine is symmetric from the aave side', () => {
  const decision = conservativeRotation({ venue: 'aave', venusBps: 400, aaveBps: 200, betterStreak: 2 });
  assert.equal(decision.action, 'rotate');
  assert.equal(decision.target, 'venus');
});

test('the machine and the predicate cannot drift apart', () => {
  // conservativeRotation is the streak state around shouldRotate, so the two
  // must agree on every edge, including the threshold itself. Two rotation
  // predicates that disagreed anywhere would be a bug the moment the one that
  // is not the gate got read as though it were.
  for (let aaveBps = 100; aaveBps <= 500; aaveBps += 1) {
    for (const betterStreak of [0, 1, 2, 3]) {
      const decision = conservativeRotation({ venue: 'venus', venusBps: 200, aaveBps, betterStreak });
      const predicate = shouldRotate({
        currentApyBps: 200,
        rivalApyBps: aaveBps,
        thresholdBps: YIELD_B_PARAMS.thresholdBps,
        consecutiveWins: aaveBps - 200 >= YIELD_B_PARAMS.thresholdBps ? betterStreak + 1 : 0,
        requiredWins: YIELD_B_PARAMS.requiredWins,
      });
      assert.equal(
        decision.action === 'rotate',
        predicate,
        `aave ${aaveBps} bps, streak ${betterStreak}`,
      );
    }
  }
});

/* ------------------------------ registry ---------------------------------- */

test('the registry record is a managed agent, configuration only until registered', () => {
  const record = AGENTS['yield-b'];
  assert.equal(record.tokenId, null);
  assert.equal(record.wallet, null);
  assert.equal(record.registrationTx, null);
  assert.equal(record.attestation, null);
  assert.deepEqual(record.proofs, []);
  assert.equal(record.managed, true);
  assert.equal(record.category, 'yield');
  assert.equal(record.category, yieldBAgent.category);
  assert.deepEqual(record.funding, { bnb: '0.0015', usdt: '1' });
});

test('the manager key file is the one fund --gen would create', () => {
  // The runner loads this exact path to sign router calls. A mismatch does not
  // fail: it disables managed mode for the agent silently, which on a page
  // offering to manage a deposit is worse than a crash.
  assert.equal(managerKeyFile('yield-b').endsWith('agent-yield-b-session.json'), true);
});

test('every managed agent in the registry has a rotation policy of its own', () => {
  // The runner refuses to service a managed agent with no policy rather than
  // falling back to another agent's. This is what keeps that from happening.
  const managed = AGENT_LIST.filter((record) => record.managed);
  assert.ok(managed.length >= 2, 'managed funds is a single-agent feature again');
  const policies = new Set(managed.map((record) => policyForAgent(record.slug)));
  for (const record of managed) {
    assert.ok(policyForAgent(record.slug), `${record.slug}: no rotation policy`);
  }
  assert.equal(policies.size, managed.length, 'two managed agents share one policy');
});

test('the published caps are the ones the tick enforces', () => {
  const { safety, execution } = AGENTS['yield-b'].manifest;
  assert.equal(safety['hysteresisBps'], YIELD_B_PARAMS.thresholdBps);
  assert.equal(safety['confirmations'], YIELD_B_PARAMS.requiredWins);
  assert.equal(safety['minHoursBetweenMoves'], YIELD_B_PARAMS.minRotationIntervalMs / 3_600_000);
  // checkEveryHours is a promise about BOTH paths. The own-capital tick keeps
  // it by running that slowly; the managed path is swept every five minutes by
  // the runner, so it keeps it through the policy's own check interval.
  assert.equal(safety['checkEveryHours'], yieldBAgent.tickIntervalMs / 3_600_000);
  assert.equal(safety['checkEveryHours'], YIELD_B_POLICY.checkIntervalMs / 3_600_000);
  assert.equal(safety['maxMovesPerDay'], YIELD_B_POLICY.maxRotationsPerDay);
  assert.equal(execution.asset, 'USDT');
  assert.equal(execution.chainId, 56);
});

test('the manifest says what the agent will never do to a managed account', () => {
  const { safety } = AGENTS['yield-b'].manifest;
  // The custody statement is the one a depositor is actually relying on, and
  // it is a property of the router rather than of this agent's good behaviour.
  assert.match(String(safety['custody']), /never send funds anywhere else/);
  assert.match(String(safety['onRevoke']), /stops all further moves/);
  assert.deepEqual(safety['venues'], ['venus', 'aave']);
});

/* ---------------------- the managed tick, both policies ------------------ */

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

function fakeCtx(opts: FakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
} {
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
      if (functionName === 'balanceOf' && address.toLowerCase() === USDT.address.toLowerCase())
        return opts.walletUsdtWei;
      if (functionName === 'balanceOf' && address.toLowerCase() === ATOKEN.toLowerCase())
        return opts.aaveATokenWei;
      throw new Error(`unexpected read ${functionName}@${address}`);
    },
  };
  const ctx = {
    name: 'yield-b',
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
  return { ctx, logs, store };
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

const ns = (key: string) => `managed:${ACCOUNT.toLowerCase()}:USDT:${key}`;

/** Venus ~199.7 bps against Aave 500 bps: a 300 bps lead, past both thresholds. */
const BIG_LEAD = { venusRatePerBlock: 285_000_000n, aaveLiquidityRate: 5n * 10n ** 25n };
/** Venus ~199.7 bps against Aave 280 bps: 80 bps, past yield's 50 and inside yield-b's 120. */
const NARROW_LEAD = { venusRatePerBlock: 285_000_000n, aaveLiquidityRate: 28n * 10n ** 24n };
/** A mandate already parked in Venus, nothing idle. */
const IN_VENUS = {
  walletUsdtWei: 0n,
  venusUnderlyingWei: 100n * 10n ** 18n,
  aaveATokenWei: 0n,
};

test('the threshold alone blocks a rotation that yield would take', async () => {
  // Same rates, same armed streak, same account. yield rotates on an 80 bps
  // lead; yield-b does not, and that difference is the product.
  const armed = { initialState: { [ns('betterStreak')]: 5 } };

  const incumbent = fakeCtx({ ...NARROW_LEAD, ...IN_VENUS, ...armed });
  const incumbentExec = fakeExecutor();
  await managedYieldTick(incumbent.ctx, incumbentExec);
  assert.deepEqual(incumbentExec.calls, ['toAave'], 'yield should rotate on an 80 bps lead');

  const conservative = fakeCtx({ ...NARROW_LEAD, ...IN_VENUS, ...armed });
  const conservativeExec = fakeExecutor();
  await managedYieldTick(conservative.ctx, conservativeExec, YIELD_B_POLICY);
  assert.deepEqual(conservativeExec.calls, []);
  const held = conservative.logs.at(-1)!;
  assert.equal(held['decision'], 'hold');
  // And the streak is reset, not merely unspent: the lead did not qualify.
  assert.equal(conservative.store.get(ns('betterStreak')), 0);
});

test('the confirmation gate alone blocks a rotation that yield would take', async () => {
  // Now the lead is 300 bps, past both thresholds, so only the confirmation
  // count differs: yield needs two checks and has them, yield-b needs three.
  const armed = { initialState: { [ns('betterStreak')]: 1 } };

  const incumbent = fakeCtx({ ...BIG_LEAD, ...IN_VENUS, ...armed });
  const incumbentExec = fakeExecutor();
  await managedYieldTick(incumbent.ctx, incumbentExec);
  assert.deepEqual(incumbentExec.calls, ['toAave'], 'yield should rotate on its second check');

  const conservative = fakeCtx({ ...BIG_LEAD, ...IN_VENUS, ...armed });
  const conservativeExec = fakeExecutor();
  await managedYieldTick(conservative.ctx, conservativeExec, YIELD_B_POLICY);
  assert.deepEqual(conservativeExec.calls, []);
  // Armed one further, so the next check is the one that acts.
  assert.equal(conservative.store.get(ns('betterStreak')), 2);
});

test('a lead that is big and confirmed does rotate', async () => {
  const { ctx, store } = fakeCtx({
    ...BIG_LEAD,
    ...IN_VENUS,
    initialState: { [ns('betterStreak')]: 2 },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, ['toAave']);
  assert.equal(store.get(ns('venue')), 'aave');
  // The rotation timestamp is written BEFORE the router call, so a crash in
  // the execute window cannot let the next tick fire a second rotation.
  assert.equal(typeof store.get(ns('lastRotateAt')), 'number');
});

test('a rotation inside the two-day floor is refused', async () => {
  const { ctx, logs } = fakeCtx({
    ...BIG_LEAD,
    ...IN_VENUS,
    initialState: {
      [ns('betterStreak')]: 2,
      [ns('lastRotateAt')]: Date.now() - DAY_MS,
    },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, []);
  assert.equal(logs.at(-1)!['decision'], 'rotate-cooldown');
});

test('past the floor the same rotation goes through', async () => {
  const { ctx } = fakeCtx({
    ...BIG_LEAD,
    ...IN_VENUS,
    initialState: {
      [ns('betterStreak')]: 2,
      [ns('lastRotateAt')]: Date.now() - 3 * DAY_MS,
    },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, ['toAave']);
});

test('the floor never delays a first deposit, only a rotation', async () => {
  // A depositor whose funds are idle must be put to work on the first tick;
  // the two-day floor is about churn between venues, not about entry.
  const { ctx } = fakeCtx({
    ...BIG_LEAD,
    walletUsdtWei: 100n * 10n ** 18n,
    venusUnderlyingWei: 0n,
    aaveATokenWei: 0n,
    initialState: { [ns('lastRotateAt')]: Date.now() },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, ['toAave']);
});

/* ------------------------- the published check cadence -------------------- */

/*
 * The manifest promises a check every twelve hours and three consecutive
 * checks before anything moves, which is a day and a half of a lead holding.
 * The managed sweep, however, runs every five minutes for every mandate, so
 * without a cadence of its own the same three confirmations would be collected
 * in fifteen minutes and a depositor who chose the patient agent would get the
 * busy one. These pin the check itself, per account, not just the rotation
 * floor that sits behind it.
 */
test('a second check inside the published interval is not a check at all', async () => {
  const { ctx, store, logs } = fakeCtx({
    ...BIG_LEAD,
    ...IN_VENUS,
    initialState: {
      [ns('betterStreak')]: 2,
      // A check ran a minute ago, which is what the five-minute sweep produces.
      [ns('lastCheckAt')]: Date.now() - 60_000,
    },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, [], 'a sweep is not a check');
  // The streak is what makes this more than a delayed rotation: three
  // confirmations must mean three checks a policy interval apart, so a sweep
  // inside the interval must not arm it.
  assert.equal(store.get(ns('betterStreak')), 2);
  assert.equal(
    logs.some((entry) => entry['decision'] === 'hold' || entry['decision'] === 'rotate'),
    false,
    'no decision is taken or logged inside the interval',
  );
});

test('past the published interval the check runs and the rotation goes through', async () => {
  const { ctx, store } = fakeCtx({
    ...BIG_LEAD,
    ...IN_VENUS,
    initialState: {
      [ns('betterStreak')]: 2,
      [ns('lastCheckAt')]: Date.now() - YIELD_B_POLICY.checkIntervalMs - 1000,
    },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, ['toAave']);
  // And the check is anchored, so the next sweep is inside the interval again.
  const checkedAt = store.get(ns('lastCheckAt')) as number;
  assert.ok(Date.now() - checkedAt < 60_000, 'the check anchors its own timestamp');
});

test('the check interval never delays a first deposit, only a check', async () => {
  // Same split as the rotation floor: idle capital is put to work on the sweep
  // that finds it, whatever the check cadence says.
  const { ctx } = fakeCtx({
    ...BIG_LEAD,
    walletUsdtWei: 100n * 10n ** 18n,
    venusUnderlyingWei: 0n,
    aaveATokenWei: 0n,
    initialState: { [ns('lastCheckAt')]: Date.now() },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, ['toAave']);
});

test('the incumbent publishes no check cadence, so its sweep is unchanged', async () => {
  // yield's manifest carries no checkEveryHours, so gating its managed path
  // would slow a live agent to match a number it never published.
  assert.equal(AGENTS['yield'].manifest.safety['checkEveryHours'], undefined);
  const { ctx } = fakeCtx({
    ...NARROW_LEAD,
    ...IN_VENUS,
    initialState: { [ns('betterStreak')]: 1, [ns('lastCheckAt')]: Date.now() },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, ['toAave']);
});

test('yield keeps its own policy when no policy is passed', async () => {
  // The default is the incumbent's live behaviour, unchanged: an 80 bps lead
  // on an armed streak still rotates, exactly as it did before yield-b existed.
  const { ctx } = fakeCtx({
    ...NARROW_LEAD,
    ...IN_VENUS,
    initialState: { [ns('betterStreak')]: 1 },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex);
  assert.deepEqual(ex.calls, ['toAave']);
});

test('a halted agent touches no managed account', async () => {
  const { ctx } = fakeCtx({
    ...BIG_LEAD,
    ...IN_VENUS,
    halted: true,
    initialState: { [ns('betterStreak')]: 2 },
  });
  const ex = fakeExecutor();
  await managedYieldTick(ctx, ex, YIELD_B_POLICY);
  assert.deepEqual(ex.calls, []);
});

/* ---------------------------- own-capital tick --------------------------- */

test('module export matches the chassis contract', () => {
  assert.equal(yieldBAgent.name, 'yield-b');
  assert.equal(yieldBAgent.category, 'yield');
  assert.equal(yieldBAgent.tickIntervalMs, 12 * 3_600_000);
  assert.equal(typeof yieldBAgent.tick, 'function');
  assert.equal(typeof yieldBAgent.status, 'function');
});

interface OwnFakeOpts extends FakeOpts {
  allowance?: bigint;
}

function ownFakeCtx(opts: OwnFakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
  writes: { fn: string; address: string }[];
} {
  const base = fakeCtx(opts);
  const writes: { fn: string; address: string }[] = [];
  const inner = (
    base.ctx.publicClient as unknown as {
      readContract(call: { address: string; functionName: string }): Promise<unknown>;
    }
  ).readContract;
  const publicClient = {
    ...(base.ctx.publicClient as unknown as Record<string, unknown>),
    async readContract(call: { address: string; functionName: string }) {
      if (call.functionName === 'allowance') return opts.allowance ?? 0n;
      return inner(call);
    },
    async simulateContract(call: { address: string; functionName: string }) {
      return { result: 0n, request: call };
    },
    async waitForTransactionReceipt() {
      return { status: 'success' };
    },
  };
  const ctx = {
    ...(base.ctx as unknown as Record<string, unknown>),
    publicClient,
    walletClient: {
      chain: { id: 56 },
      async writeContract(call: { address: string; functionName: string }) {
        writes.push({ fn: call.functionName, address: call.address });
        return `0x${'cd'.repeat(32)}`;
      },
    },
  } as unknown as AgentContext;
  return { ctx, logs: base.logs, store: base.store, writes };
}

test('own capital deploys into the winning venue, keeping the x402 reserve back', async () => {
  const { ctx, logs, writes } = ownFakeCtx({
    ...BIG_LEAD,
    walletUsdtWei: toBaseUnits('1', USDT.decimals),
    venusUnderlyingWei: 0n,
    aaveATokenWei: 0n,
  });
  await yieldBAgent.tick(ctx);
  const decision = logs.find((l) => l.decision === 'enter')!;
  assert.ok(decision, `expected an enter, got ${JSON.stringify(logs.map((l) => l.decision))}`);
  assert.equal(decision['target'], 'aave');
  // 1 USDT less the 0.1 reserve.
  assert.equal(decision['amount'], '0.9');
  assert.deepEqual(
    writes.map((w) => w.fn),
    ['approve', 'supply'],
  );
});

test('own capital below the reserve reports unfunded rather than trading dust', async () => {
  const { ctx, logs, writes } = ownFakeCtx({
    ...BIG_LEAD,
    walletUsdtWei: toBaseUnits('0.1', USDT.decimals),
    venusUnderlyingWei: 0n,
    aaveATokenWei: 0n,
  });
  await yieldBAgent.tick(ctx);
  assert.equal(logs.at(-1)!['decision'], 'unfunded');
  assert.deepEqual(writes, []);
});

test('own capital holds on a lead inside the threshold', async () => {
  const { ctx, logs, writes } = ownFakeCtx({
    ...NARROW_LEAD,
    walletUsdtWei: 0n,
    venusUnderlyingWei: toBaseUnits('1', USDT.decimals),
    aaveATokenWei: 0n,
    initialState: { betterStreak: 5 },
  });
  await yieldBAgent.tick(ctx);
  assert.equal(logs.at(-1)!['decision'], 'hold');
  assert.deepEqual(writes, []);
});

test('own capital honours the same two-day floor between rotations', async () => {
  const { ctx, logs, writes } = ownFakeCtx({
    ...BIG_LEAD,
    walletUsdtWei: 0n,
    venusUnderlyingWei: toBaseUnits('1', USDT.decimals),
    aaveATokenWei: 0n,
    initialState: { betterStreak: 2, lastRotateAt: Date.now() - DAY_MS },
  });
  await yieldBAgent.tick(ctx);
  assert.equal(logs.at(-1)!['decision'], 'rotate-cooldown');
  assert.deepEqual(writes, []);
});

test('status reports the policy a depositor is choosing between', async () => {
  const { ctx } = ownFakeCtx({
    ...NARROW_LEAD,
    walletUsdtWei: 0n,
    venusUnderlyingWei: toBaseUnits('1', USDT.decimals),
    aaveATokenWei: 0n,
  });
  const status = (await yieldBAgent.status(ctx)) as {
    venue: string;
    thresholdBps: number;
    requiredWins: number;
    minHoursBetweenMoves: number;
    edgeBps: number;
    betterStreak: number;
  };
  assert.equal(status.venue, 'venus');
  assert.equal(status.thresholdBps, YIELD_B_PARAMS.thresholdBps);
  assert.equal(status.requiredWins, YIELD_B_PARAMS.requiredWins);
  assert.equal(status.minHoursBetweenMoves, 48);
  assert.ok(status.edgeBps > 79 && status.edgeBps < 81, `edge ${status.edgeBps}`);
  assert.equal(status.betterStreak, 0);
});
