/**
 * The Venus guardian's only new arithmetic is turning what Venus publishes into
 * the 1e18 health factor the Aave guardian's planner already speaks, so most of
 * this file is about that derivation and its round trip through `planRepair`:
 * the same repay sizing, reached from a protocol that reports liquidity and
 * shortfall instead of a ratio.
 *
 * The rest drives the actual module through a fake Venus so the wiring around the
 * derivation is exercised too: which markets count as collateral, what a zero
 * oracle price does, the warn/act thresholds, the wallet budget cap, and the
 * daily repay cap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';

import {
  ACT_AT,
  MAX_UINT256,
  TARGET_HF,
  WARN_AT,
  hfWadToNumber,
  planRepair,
} from '../src/agents/health-factor';
import {
  MAX_REPAYS_PER_DAY,
  VENUS_COMPTROLLER,
  VENUS_ORACLE,
  VENUS_VBNB,
  VENUS_VUSDC,
  VENUS_VUSDT,
  aggregateVenusPosition,
  planVenusUsdtRepair,
  shortfallAgreesWithHf,
  venusGuardianAgent,
  venusHfWad,
} from '../src/agents/venus-guardian';
import type { AgentContext } from '../src/types';

const USDT = TOKENS_BSC['USDT']!;

const WAD = BigInt(10) ** BigInt(18);
/** USD in 1e18, written through 1e6 so the literals stay readable. */
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * BigInt(10) ** BigInt(12);
const cf = (fraction: number) => BigInt(Math.round(fraction * 1e6)) * BigInt(10) ** BigInt(12);

const approx = (actual: number, expected: number, eps: number) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );

/* ------------------------- the derived health factor ---------------------- */

test('derives a 1e18-scaled health factor from venus values', () => {
  // 160 collateral at 0.8 collateral factor against 100 debt = 1.28
  const hf = venusHfWad({
    collateralUsdWad: usd(160),
    borrowUsdWad: usd(100),
    collateralFactorMantissa: cf(0.8),
  });
  approx(hfWadToNumber(hf), 1.28, 0.0001);
});

test('no debt reads as no risk', () => {
  const hf = venusHfWad({
    collateralUsdWad: usd(160),
    borrowUsdWad: BigInt(0),
    collateralFactorMantissa: cf(0.8),
  });
  assert.equal(hf, MAX_UINT256);
});

test('debt with nothing backing it reads as the worst possible health', () => {
  // Not Infinity and not a throw: a borrow against zero eligible collateral is
  // liquidatable right now, so it must land in the act zone rather than look
  // like an absent position.
  const noCollateral = venusHfWad({
    collateralUsdWad: BigInt(0),
    borrowUsdWad: usd(100),
    collateralFactorMantissa: cf(0.8),
  });
  assert.equal(noCollateral, BigInt(0));
  // Same for collateral the comptroller gives no borrowing power to.
  const noFactor = venusHfWad({
    collateralUsdWad: usd(160),
    borrowUsdWad: usd(100),
    collateralFactorMantissa: BigInt(0),
  });
  assert.equal(noFactor, BigInt(0));
});

test('the collateral factor is what separates venus from a raw ltv', () => {
  // The same collateral and debt at three governance settings. Reading the
  // factor live is the point: a governance cut moves the health factor without
  // anything about the position changing.
  const at = (factor: number) =>
    hfWadToNumber(
      venusHfWad({
        collateralUsdWad: usd(100),
        borrowUsdWad: usd(50),
        collateralFactorMantissa: cf(factor),
      }),
    );
  approx(at(0.8), 1.6, 1e-9);
  approx(at(0.825), 1.65, 1e-9);
  approx(at(0.7), 1.4, 1e-9);
});

test('feeds the existing repay planner to land on target', () => {
  const collateral = usd(160);
  const debt = usd(100);
  const factor = cf(0.8);
  const hf = venusHfWad({
    collateralUsdWad: collateral,
    borrowUsdWad: debt,
    collateralFactorMantissa: factor,
  });
  const repay = planRepair(hf, debt, TARGET_HF);
  const after = venusHfWad({
    collateralUsdWad: collateral,
    borrowUsdWad: debt - repay,
    collateralFactorMantissa: factor,
  });
  approx(hfWadToNumber(after), TARGET_HF, 0.001);
});

test('the round trip lands on target from anywhere below it', () => {
  // The property rather than one example: whatever the shortfall, one planned
  // repay puts the position exactly on target and never repays more than the
  // debt. This is what makes reusing the Aave planner sound rather than lucky.
  const collateral = usd(100);
  const factor = cf(0.8);
  for (let debtUsd = 51; debtUsd <= 400; debtUsd += 7) {
    const debt = usd(debtUsd);
    const hf = venusHfWad({
      collateralUsdWad: collateral,
      borrowUsdWad: debt,
      collateralFactorMantissa: factor,
    });
    if (hfWadToNumber(hf) >= TARGET_HF) continue;
    const repay = planRepair(hf, debt, TARGET_HF);
    assert.ok(repay > BigInt(0) && repay <= debt, `debt ${debtUsd}: repay ${repay} out of bounds`);
    const after = venusHfWad({
      collateralUsdWad: collateral,
      borrowUsdWad: debt - repay,
      collateralFactorMantissa: factor,
    });
    approx(hfWadToNumber(after), TARGET_HF, 0.001);
  }
});

test('an underwater position still produces a bounded repay', () => {
  const debt = usd(100);
  const hf = venusHfWad({
    collateralUsdWad: usd(50),
    borrowUsdWad: debt,
    collateralFactorMantissa: cf(0.8),
  });
  const repay = planRepair(hf, debt, TARGET_HF);
  assert.ok(repay > BigInt(0) && repay <= debt, `repay ${repay} out of bounds`);
});

/* ----------------------------- many markets ------------------------------ */

test('collateral is value weighted across every market the account entered', () => {
  // $100 at 0.80 plus $100 at 0.825 is $200 of borrowing power 0.8125, so the
  // aggregate must sit between the two factors and not at either one.
  const agg = aggregateVenusPosition([
    { vToken: VENUS_VBNB, suppliedUsdWad: usd(100), borrowUsdWad: BigInt(0), collateralFactorMantissa: cf(0.8) },
    { vToken: VENUS_VUSDC, suppliedUsdWad: usd(100), borrowUsdWad: BigInt(0), collateralFactorMantissa: cf(0.825) },
    { vToken: VENUS_VUSDT, suppliedUsdWad: BigInt(0), borrowUsdWad: usd(50), collateralFactorMantissa: cf(0.8) },
  ]);
  assert.equal(agg.collateralUsdWad, usd(200));
  assert.equal(agg.borrowUsdWad, usd(50));
  approx(Number(agg.collateralFactorMantissa) / 1e18, 0.8125, 1e-9);
  approx(hfWadToNumber(venusHfWad(agg)), 3.25, 1e-9);
});

test('the weighted aggregate matches the exact sum of borrowing power', () => {
  // aggregateVenusPosition folds to a single factor because that is the shape
  // venusHfWad takes; the fold must not move the answer away from the exact
  // sum(value * factor) / debt it stands in for.
  const legs = [
    { vToken: VENUS_VBNB, suppliedUsdWad: usd(37.13), borrowUsdWad: BigInt(0), collateralFactorMantissa: cf(0.8) },
    { vToken: VENUS_VUSDC, suppliedUsdWad: usd(11.07), borrowUsdWad: usd(3.5), collateralFactorMantissa: cf(0.825) },
    { vToken: VENUS_VUSDT, suppliedUsdWad: usd(2.91), borrowUsdWad: usd(9.33), collateralFactorMantissa: cf(0.8) },
  ];
  const agg = aggregateVenusPosition(legs);
  const exactPower = legs.reduce(
    (acc, leg) => acc + (leg.suppliedUsdWad * leg.collateralFactorMantissa) / WAD,
    BigInt(0),
  );
  const exactHf = Number(exactPower) / Number(agg.borrowUsdWad);
  approx(hfWadToNumber(venusHfWad(agg)), exactHf, 1e-9);
});

test('an empty position aggregates to no risk rather than a division by zero', () => {
  const agg = aggregateVenusPosition([]);
  assert.equal(agg.collateralUsdWad, BigInt(0));
  assert.equal(agg.borrowUsdWad, BigInt(0));
  assert.equal(agg.collateralFactorMantissa, BigInt(0));
  assert.equal(venusHfWad(agg), MAX_UINT256);
});

test('one repayable debt leg covers the full repair instead of a proportional fraction', () => {
  const plan = planVenusUsdtRepair({
    hfWad: cf(1.2),
    totalDebtUsdWad: usd(4),
    usdtDebtWei: toBaseUnits('2', USDT.decimals),
    usdtDebtUsdWad: usd(2),
    usdtBalance: toBaseUnits('2', USDT.decimals),
    targetHf: 1.6,
  });
  assert.equal(plan.repayBase, usd(1));
  assert.equal(plan.repayUsdt, toBaseUnits('1', USDT.decimals));
});

/* ------------------- cross-check against what venus says ----------------- */

test('the derived health factor agrees with the comptroller shortfall', () => {
  // Venus reports solvency as a shortfall, not a ratio. Our derivation has to
  // agree with it on the only question they both answer, or one of the two is
  // reading the position wrong.
  assert.equal(shortfallAgreesWithHf(cf(1.4), BigInt(0)), true);
  assert.equal(shortfallAgreesWithHf(cf(0.8), usd(12)), true);
  assert.equal(shortfallAgreesWithHf(MAX_UINT256, BigInt(0)), true);
  // Solvent by our math while the comptroller reports a shortfall, and the
  // mirror image: both are disagreements worth surfacing.
  assert.equal(shortfallAgreesWithHf(cf(1.4), usd(12)), false);
  assert.equal(shortfallAgreesWithHf(cf(0.8), BigInt(0)), false);
  assert.equal(shortfallAgreesWithHf(MAX_UINT256, usd(1)), false);
});

test('a health factor sitting on 1.0 is not called a disagreement', () => {
  // Rounding at the boundary is not evidence of a wrong read, so a hair either
  // side of 1.0 is consistent with either answer.
  assert.equal(shortfallAgreesWithHf(WAD, BigInt(0)), true);
  assert.equal(shortfallAgreesWithHf(WAD, BigInt(1)), true);
  assert.equal(shortfallAgreesWithHf(WAD - BigInt(1), BigInt(0)), true);
});

/* ------------------------- manifest matches the code --------------------- */

test('the published thresholds are the ones the tick enforces', () => {
  const { safety, execution } = AGENTS['venus-guardian'].manifest;
  assert.equal(safety['warnHF'], WARN_AT);
  assert.equal(safety['actHF'], ACT_AT);
  assert.equal(safety['targetHF'], TARGET_HF);
  assert.equal(safety['maxRepaysPerDay'], MAX_REPAYS_PER_DAY);
  assert.equal(safety['tickSeconds'], venusGuardianAgent.tickIntervalMs / 1000);
  assert.deepEqual(safety['actions'], ['repay']);
  assert.equal(execution.protocol, 'venus');
  assert.equal(execution.chainId, 56);
});

test('the manifest says where the health factor comes from', () => {
  // Venus publishes no health factor, so a hirer reading this manifest is owed
  // the derivation rather than a number that looks like a protocol read.
  const { safety } = AGENTS['venus-guardian'].manifest;
  assert.match(String(safety['healthFactorSource']), /collateral factor/);
  assert.match(String(safety['onBudgetExhausted']), /monitor/i);
});

test('the registry record is configuration only until it is registered', () => {
  const record = AGENTS['venus-guardian'];
  assert.equal(record.tokenId, null);
  assert.equal(record.wallet, null);
  assert.equal(record.registrationTx, null);
  assert.equal(record.attestation, null);
  assert.deepEqual(record.proofs, []);
  assert.equal(record.managed, false);
  assert.equal(record.category, 'health-factor');
  assert.equal(record.category, venusGuardianAgent.category);
  assert.deepEqual(record.funding, { bnb: '0.0015', usdt: '2', wbnb: '0.005' });
});

/* ---------------------------------- tick --------------------------------- */

interface MarketFake {
  supplied?: bigint;
  borrowed?: bigint;
  /** Oracle price, 1e(36 - underlying decimals). Every asset here is 18-dec. */
  price?: bigint;
  collateralFactor?: bigint;
  isListed?: boolean;
}

interface FakeOpts {
  entered?: `0x${string}`[];
  markets?: Record<string, MarketFake>;
  walletUsdtWei?: bigint;
  liquidityWad?: bigint;
  shortfallWad?: bigint;
  liquidityError?: bigint;
  vaiDebtWei?: bigint;
  oracle?: string;
  allowance?: bigint;
  allowAction?: boolean;
  initialState?: Record<string, unknown>;
}

const RECORDED_FACTOR: Record<string, bigint> = {
  [VENUS_VBNB.toLowerCase()]: cf(0.8),
  [VENUS_VUSDT.toLowerCase()]: cf(0.8),
  [VENUS_VUSDC.toLowerCase()]: cf(0.825),
};

function fakeCtx(opts: FakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
  writes: { fn: string; address: string; args?: unknown[] }[];
  allowCalls: string[];
} {
  const store = new Map<string, unknown>(Object.entries(opts.initialState ?? {}));
  const logs: Record<string, unknown>[] = [];
  const writes: { fn: string; address: string; args?: unknown[] }[] = [];
  const allowCalls: string[] = [];
  const entered = opts.entered ?? [];
  const market = (address: string): MarketFake => opts.markets?.[address.toLowerCase()] ?? {};

  const publicClient = {
    async readContract(call: { address: string; functionName: string; args?: unknown[] }) {
      const { address, functionName, args } = call;
      switch (functionName) {
        case 'getAssetsIn':
          return entered;
        case 'oracle':
          return opts.oracle ?? VENUS_ORACLE;
        case 'getAccountLiquidity':
          return [
            opts.liquidityError ?? BigInt(0),
            opts.liquidityWad ?? BigInt(0),
            opts.shortfallWad ?? BigInt(0),
          ];
        case 'mintedVAIs':
          return opts.vaiDebtWei ?? BigInt(0);
        case 'markets': {
          const target = String(args![0]);
          const m = market(target);
          return [
            m.isListed ?? true,
            m.collateralFactor ?? RECORDED_FACTOR[target.toLowerCase()] ?? cf(0.8),
            true,
          ];
        }
        case 'getUnderlyingPrice':
          return market(String(args![0])).price ?? WAD;
        case 'balanceOfUnderlying':
          return market(address).supplied ?? BigInt(0);
        case 'borrowBalanceCurrent':
          return market(address).borrowed ?? BigInt(0);
        case 'balanceOf':
          return opts.walletUsdtWei ?? BigInt(0);
        case 'allowance':
          return opts.allowance ?? BigInt(0);
        default:
          throw new Error(`unexpected read ${functionName}@${address}`);
      }
    },
    async simulateContract(call: { address: string; functionName: string; args?: unknown[] }) {
      return { result: BigInt(0), request: call };
    },
    async waitForTransactionReceipt() {
      return { status: 'success' };
    },
  };

  const ctx = {
    name: 'venus-guardian',
    chainId: 56,
    account: { address: '0x000000000000000000000000000000000000dEaD' },
    publicClient,
    walletClient: {
      chain: { id: 56 },
      async writeContract(call: { address: string; functionName: string; args?: unknown[] }) {
        writes.push({ fn: call.functionName, address: call.address, args: call.args });
        return `0x${'ab'.repeat(32)}`;
      },
    },
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
      isHalted: () => ({ halted: false }),
      allowAction: (kind: string) => {
        allowCalls.push(kind);
        return opts.allowAction ?? true;
      },
    },
  } as unknown as AgentContext;
  return { ctx, logs, store, writes, allowCalls };
}

const BNB_PRICE = usd(600);

/** 0.01 BNB at $600 gives $6 of collateral, $4.80 of it borrowable at 0.80. */
function position(debtUsdt: string, opts: Partial<FakeOpts> = {}): FakeOpts {
  return {
    entered: [VENUS_VBNB, VENUS_VUSDT],
    markets: {
      [VENUS_VBNB.toLowerCase()]: { supplied: toBaseUnits('0.01', 18), price: BNB_PRICE },
      [VENUS_VUSDT.toLowerCase()]: { borrowed: toBaseUnits(debtUsdt, USDT.decimals), price: WAD },
    },
    walletUsdtWei: toBaseUnits('2', USDT.decimals),
    ...opts,
  };
}

test('module export matches the chassis contract', () => {
  assert.equal(venusGuardianAgent.name, 'venus-guardian');
  assert.equal(venusGuardianAgent.category, 'health-factor');
  assert.equal(venusGuardianAgent.tickIntervalMs, 60_000);
  assert.equal(typeof venusGuardianAgent.tick, 'function');
  assert.equal(typeof venusGuardianAgent.status, 'function');
});

test('an account with no venus position reports no risk and does nothing', async () => {
  const { ctx, logs, writes, allowCalls } = fakeCtx({ entered: [] });
  await venusGuardianAgent.tick(ctx);
  const hf = logs.find((l) => l.event === 'hf')!;
  assert.ok(hf, `expected an hf log, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(hf['hf'], 'Infinity');
  assert.equal(hf['zone'], 'healthy');
  assert.deepEqual(writes, []);
  assert.deepEqual(allowCalls, []);
});

test('a healthy position is measured and left alone', async () => {
  // $4.80 of borrowing power against $2 of debt is 2.4.
  const { ctx, logs, writes } = fakeCtx(position('2'));
  await venusGuardianAgent.tick(ctx);
  const hf = logs.find((l) => l.event === 'hf')!;
  approx(hf['hf'] as number, 2.4, 1e-6);
  assert.equal(hf['zone'], 'healthy');
  assert.deepEqual(writes, []);
});

test('the warn zone logs once on the way down and does not repay', async () => {
  // $4.80 against $3.50 is 1.371: below warn (1.5), above act (1.3).
  const { ctx, logs, store, writes } = fakeCtx(position('3.5'));
  await venusGuardianAgent.tick(ctx);
  assert.ok(logs.some((l) => l.event === 'hf-warn'));
  assert.equal(store.get('hfZone'), 'warn');
  assert.deepEqual(writes, []);

  const second = fakeCtx(position('3.5', { initialState: { hfZone: 'warn' } }));
  await venusGuardianAgent.tick(second.ctx);
  assert.equal(second.logs.some((l) => l.event === 'hf-warn'), false);
});

test('the act zone repays usdt sized to land back on target', async () => {
  // $4.80 against $4 is 1.20, under act. planRepair to 1.6 wants $1 of the $4
  // debt repaid, and the whole debt is USDT, so that is 1 USDT.
  const { ctx, logs, writes } = fakeCtx(position('4'));
  await venusGuardianAgent.tick(ctx);

  const plan = logs.find((l) => l.event === 'repair-plan')!;
  assert.ok(plan, `expected a repair plan, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(plan['repayUsdt'], '1');
  assert.equal(plan['cappedByBudget'], false);

  assert.deepEqual(
    writes.map((w) => w.fn),
    ['approve', 'repayBorrow'],
  );
  assert.equal(writes[1]!.address.toLowerCase(), VENUS_VUSDT.toLowerCase());
  assert.equal(writes[1]!.args![0], toBaseUnits('1', USDT.decimals));
  assert.ok(logs.some((l) => l.event === 'repair-done'));
});

test('separate VAI debt is included in health and full repair sizing', async () => {
  // $4.80 of borrowing power against $2 USDT + $2 VAI is 1.20. Reaching 1.6
  // requires $1 total repayment. USDT is the leg this guardian can act on, so
  // it repays the full $1 rather than only USDT's proportional half.
  const { ctx, logs, writes } = fakeCtx(
    position('2', { vaiDebtWei: toBaseUnits('2', 18) }),
  );
  await venusGuardianAgent.tick(ctx);

  const health = logs.find((l) => l.event === 'hf')!;
  assert.equal(health['debtUsd'], '4');
  assert.equal(health['vaiDebt'], '2');
  approx(health['hf'] as number, 1.2, 1e-6);

  const plan = logs.find((l) => l.event === 'repair-plan')!;
  assert.equal(plan['repayUsdt'], '1');
  assert.equal(writes.at(-1)?.args?.[0], toBaseUnits('1', USDT.decimals));
});

test('the repay is capped by the wallet, and says so', async () => {
  const { ctx, logs, writes } = fakeCtx(
    position('4', { walletUsdtWei: toBaseUnits('0.4', USDT.decimals) }),
  );
  await venusGuardianAgent.tick(ctx);
  const plan = logs.find((l) => l.event === 'repair-plan')!;
  assert.equal(plan['cappedByBudget'], true);
  assert.equal(plan['repayUsdt'], '0.4');
  assert.equal(writes.at(-1)!.args![0], toBaseUnits('0.4', USDT.decimals));
});

test('an empty repay budget keeps monitoring instead of throwing', async () => {
  const { ctx, logs, writes } = fakeCtx(position('4', { walletUsdtWei: BigInt(0) }));
  await venusGuardianAgent.tick(ctx);
  assert.ok(logs.some((l) => l.event === 'budget-exhausted'));
  assert.deepEqual(writes, []);
});

test('the daily cap stops the seventh repay of the day', async () => {
  const { ctx, logs, writes, allowCalls } = fakeCtx(position('4', { allowAction: false }));
  await venusGuardianAgent.tick(ctx);
  const skip = logs.find((l) => l.event === 'repair-skip')!;
  assert.equal(skip['reason'], 'action-cap');
  assert.equal(skip['maxPerDay'], MAX_REPAYS_PER_DAY);
  assert.deepEqual(allowCalls, ['repay']);
  assert.deepEqual(writes, []);
});

test('debt in a token the guardian cannot repay is reported, not ignored', async () => {
  // The budget is USDT, so a pure USDC borrow is outside what this agent can
  // repair. Saying so is the point: silently logging a zero repay would read
  // as "nothing to do" on a position heading for liquidation.
  const { ctx, logs, writes } = fakeCtx({
    entered: [VENUS_VBNB, VENUS_VUSDC],
    markets: {
      [VENUS_VBNB.toLowerCase()]: { supplied: toBaseUnits('0.01', 18), price: BNB_PRICE },
      [VENUS_VUSDC.toLowerCase()]: { borrowed: toBaseUnits('4', 18), price: WAD },
    },
    walletUsdtWei: toBaseUnits('2', USDT.decimals),
  });
  await venusGuardianAgent.tick(ctx);
  const skip = logs.find((l) => l.event === 'repair-skip')!;
  assert.equal(skip['reason'], 'no-usdt-debt');
  assert.deepEqual(writes, []);
});

test('collateral in a delisted market counts for nothing, as the comptroller counts it', async () => {
  const { ctx, logs } = fakeCtx(
    position('4', {
      markets: {
        [VENUS_VBNB.toLowerCase()]: {
          supplied: toBaseUnits('0.01', 18),
          price: BNB_PRICE,
          isListed: false,
        },
        [VENUS_VUSDT.toLowerCase()]: { borrowed: toBaseUnits('4', USDT.decimals), price: WAD },
      },
    }),
  );
  await venusGuardianAgent.tick(ctx);
  assert.ok(logs.some((l) => l.event === 'venus-market-unlisted'));
  const hf = logs.find((l) => l.event === 'hf')!;
  assert.equal(hf['hf'], 0);
  assert.equal(hf['zone'], 'act');
});

test('a zero oracle price stops the tick instead of pricing debt away', async () => {
  // A zero price on the borrowed asset makes the debt disappear and the
  // guardian go quiet on a position that is about to be liquidated. Refusing
  // to act on it is the only safe read.
  const { ctx } = fakeCtx(
    position('4', {
      markets: {
        [VENUS_VBNB.toLowerCase()]: { supplied: toBaseUnits('0.01', 18), price: BNB_PRICE },
        [VENUS_VUSDT.toLowerCase()]: { borrowed: toBaseUnits('4', USDT.decimals), price: BigInt(0) },
      },
    }),
  );
  await assert.rejects(venusGuardianAgent.tick(ctx), /zero oracle price/);
});

test('a comptroller error on the liquidity read stops the tick', async () => {
  const { ctx } = fakeCtx(position('4', { liquidityError: BigInt(13) }));
  await assert.rejects(venusGuardianAgent.tick(ctx), /getAccountLiquidity error 13/);
});

test('a rotated oracle and a moved collateral factor are surfaced, not fatal', async () => {
  // Governance can do both. Refusing to guard through either would take the
  // agent offline exactly when a parameter change is repricing the position.
  const { ctx, logs } = fakeCtx(
    position('2', {
      oracle: '0x0000000000000000000000000000000000000BAD',
      markets: {
        [VENUS_VBNB.toLowerCase()]: {
          supplied: toBaseUnits('0.01', 18),
          price: BNB_PRICE,
          collateralFactor: cf(0.6),
        },
        [VENUS_VUSDT.toLowerCase()]: { borrowed: toBaseUnits('2', USDT.decimals), price: WAD },
      },
    }),
  );
  await venusGuardianAgent.tick(ctx);
  assert.ok(logs.some((l) => l.event === 'venus-oracle-rotated'));
  const drift = logs.find((l) => l.event === 'venus-collateral-factor-drift')!;
  assert.ok(drift, `expected a drift log, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(drift['vToken'], VENUS_VBNB);
  // And the live factor is what the health factor is computed from: $6 at 0.60
  // is $3.60 against $2, not the $4.80 the recorded factor would give.
  approx(logs.find((l) => l.event === 'hf')!['hf'] as number, 1.8, 1e-6);
});

test('the comptroller shortfall disagreeing with our math is surfaced', async () => {
  const { ctx, logs } = fakeCtx(position('2', { shortfallWad: usd(1) }));
  await venusGuardianAgent.tick(ctx);
  assert.ok(logs.some((l) => l.event === 'venus-liquidity-disagreement'));
});

test('the agent reads the recorded comptroller, not one it was handed', async () => {
  // The addresses are pinned in the module rather than configured, so a wrong
  // one cannot be introduced by an env var or a stale state file.
  const reads: string[] = [];
  const { ctx } = fakeCtx(position('2'));
  const client = ctx.publicClient as unknown as {
    readContract(call: { address: string; functionName: string; args?: unknown[] }): Promise<unknown>;
  };
  const inner = client.readContract.bind(client);
  client.readContract = async (call) => {
    reads.push(`${call.functionName}@${call.address.toLowerCase()}`);
    return inner(call);
  };
  await venusGuardianAgent.tick(ctx);
  assert.ok(reads.includes(`getAssetsIn@${VENUS_COMPTROLLER.toLowerCase()}`));
  assert.ok(reads.includes(`markets@${VENUS_COMPTROLLER.toLowerCase()}`));
  assert.ok(reads.includes(`getUnderlyingPrice@${VENUS_ORACLE.toLowerCase()}`));
});

test('status reports the derived health factor and the budget behind it', async () => {
  const { ctx } = fakeCtx(position('4'));
  const status = (await venusGuardianAgent.status(ctx)) as {
    protocol: string;
    healthFactor: number | string;
    warnAt: number;
    actAt: number;
    targetAfterRepair: number;
    repayBudgetUsdt: string;
    collateralUsd: string;
    debtUsd: string;
    actionsToday: number;
  };
  assert.equal(status.protocol, 'venus');
  approx(status.healthFactor as number, 1.2, 1e-6);
  assert.equal(status.warnAt, WARN_AT);
  assert.equal(status.actAt, ACT_AT);
  assert.equal(status.targetAfterRepair, TARGET_HF);
  assert.equal(status.repayBudgetUsdt, '2');
  assert.equal(status.collateralUsd, '6');
  assert.equal(status.debtUsd, '4');
  assert.equal(status.actionsToday, 0);
});
