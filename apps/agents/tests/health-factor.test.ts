import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACT_AT,
  MAX_UINT256,
  TARGET_HF,
  WARN_AT,
  classifyHf,
  evaluateThresholds,
  hfWadToNumber,
  planRepair,
  planRepayAmounts,
  scaleRepayToToken,
  type HfZone,
} from '../src/agents/health-factor';

const WAD = BigInt(10) ** BigInt(18);

function wad(hf: number): bigint {
  return BigInt(Math.round(hf * 1e6)) * (BigInt(10) ** BigInt(12));
}

// ---------------------------------------------------------------------------
// hfWadToNumber
// ---------------------------------------------------------------------------

test('hfWadToNumber treats type(uint256).max as Infinity', () => {
  assert.equal(hfWadToNumber(MAX_UINT256), Infinity);
});

test('hfWadToNumber scales 1e18 to 1.0', () => {
  assert.equal(hfWadToNumber(WAD), 1);
});

test('hfWadToNumber scales 1.5e18 to 1.5', () => {
  assert.ok(Math.abs(hfWadToNumber(wad(1.5)) - 1.5) < 1e-9);
});

test('hfWadToNumber returns 0 for zero', () => {
  assert.equal(hfWadToNumber(BigInt(0)), 0);
});

// ---------------------------------------------------------------------------
// planRepair
// ---------------------------------------------------------------------------

test('planRepair at hf 1.2 targeting 1.6 repays a quarter of the debt', () => {
  const debt = BigInt('80000000'); // 0.8 in 8-decimal base currency
  const repay = planRepair(wad(1.2), debt, 1.6);
  assert.equal(repay, BigInt('20000000'));
});

test('planRepair lands the post-repay hf on the target', () => {
  const debt = BigInt('123456789');
  const hf = wad(1.11);
  const repay = planRepair(hf, debt, TARGET_HF);
  const newDebt = debt - repay;
  const newHf = Number((hf * debt) / newDebt) / 1e18;
  assert.ok(Math.abs(newHf - TARGET_HF) < 0.001, `newHf ${newHf}`);
});

test('planRepair returns zero when hf is already at or above target', () => {
  const debt = BigInt('80000000');
  assert.equal(planRepair(wad(1.6), debt, 1.6), BigInt(0));
  assert.equal(planRepair(wad(2.5), debt, 1.6), BigInt(0));
});

test('planRepair returns zero with no debt', () => {
  assert.equal(planRepair(wad(1.1), BigInt(0), 1.6), BigInt(0));
});

test('planRepair returns zero when hf is Infinity (max uint)', () => {
  assert.equal(planRepair(MAX_UINT256, BigInt('80000000'), 1.6), BigInt(0));
});

test('planRepair repays the full debt when hf is zero', () => {
  const debt = BigInt('80000000');
  assert.equal(planRepair(BigInt(0), debt, 1.6), debt);
});

// ---------------------------------------------------------------------------
// scaleRepayToToken
// ---------------------------------------------------------------------------

test('scaleRepayToToken scales proportionally to the base-currency share', () => {
  const totalDebtBase = BigInt('80000000');
  const repayBase = BigInt('20000000'); // 25 percent of the debt
  const usdtDebt = BigInt('800000000000000000'); // 0.8 USDT, 18 decimals
  assert.equal(
    scaleRepayToToken(repayBase, totalDebtBase, usdtDebt),
    BigInt('200000000000000000'),
  );
});

test('scaleRepayToToken never exceeds the token debt', () => {
  const totalDebtBase = BigInt('80000000');
  const usdtDebt = BigInt('800000000000000000');
  const out = scaleRepayToToken(BigInt('999999999999'), totalDebtBase, usdtDebt);
  assert.equal(out, usdtDebt);
});

test('scaleRepayToToken returns zero on zero inputs', () => {
  assert.equal(scaleRepayToToken(BigInt(0), BigInt('80000000'), BigInt(10)), BigInt(0));
  assert.equal(scaleRepayToToken(BigInt(10), BigInt(0), BigInt(10)), BigInt(0));
});

// ---------------------------------------------------------------------------
// planRepayAmounts
// ---------------------------------------------------------------------------

test('planRepayAmounts repays to target when budget suffices', () => {
  const plan = planRepayAmounts({
    hfWad: wad(1.2),
    totalDebtBase: BigInt('80000000'),
    usdtDebt: BigInt('800000000000000000'),
    usdtBalance: BigInt('1000000000000000000'),
    targetHf: 1.6,
  });
  assert.equal(plan.repayUsdt, BigInt('200000000000000000'));
  assert.equal(plan.cappedByBudget, false);
});

test('planRepayAmounts caps at the wallet balance', () => {
  const plan = planRepayAmounts({
    hfWad: wad(1.2),
    totalDebtBase: BigInt('80000000'),
    usdtDebt: BigInt('800000000000000000'),
    usdtBalance: BigInt('50000000000000000'), // 0.05 USDT only
    targetHf: 1.6,
  });
  assert.equal(plan.repayUsdt, BigInt('50000000000000000'));
  assert.equal(plan.cappedByBudget, true);
});

test('planRepayAmounts is zero when hf is healthy', () => {
  const plan = planRepayAmounts({
    hfWad: wad(1.7),
    totalDebtBase: BigInt('80000000'),
    usdtDebt: BigInt('800000000000000000'),
    usdtBalance: BigInt('1000000000000000000'),
    targetHf: 1.6,
  });
  assert.equal(plan.repayBase, BigInt(0));
  assert.equal(plan.repayUsdt, BigInt(0));
  assert.equal(plan.cappedByBudget, false);
});

test('planRepayAmounts with a zero balance plans zero and flags the cap', () => {
  const plan = planRepayAmounts({
    hfWad: wad(1.2),
    totalDebtBase: BigInt('80000000'),
    usdtDebt: BigInt('800000000000000000'),
    usdtBalance: BigInt(0),
    targetHf: 1.6,
  });
  assert.equal(plan.repayUsdt, BigInt(0));
  assert.equal(plan.cappedByBudget, true);
});

// ---------------------------------------------------------------------------
// classifyHf
// ---------------------------------------------------------------------------

test('classifyHf zones and boundaries', () => {
  assert.equal(classifyHf(Infinity, WARN_AT, ACT_AT), 'healthy');
  assert.equal(classifyHf(2.0, WARN_AT, ACT_AT), 'healthy');
  assert.equal(classifyHf(1.5, WARN_AT, ACT_AT), 'healthy'); // boundary is exclusive
  assert.equal(classifyHf(1.49, WARN_AT, ACT_AT), 'warn');
  assert.equal(classifyHf(1.3, WARN_AT, ACT_AT), 'warn'); // boundary is exclusive
  assert.equal(classifyHf(1.29, WARN_AT, ACT_AT), 'act');
  assert.equal(classifyHf(0.99, WARN_AT, ACT_AT), 'act');
});

// ---------------------------------------------------------------------------
// evaluateThresholds transitions
// ---------------------------------------------------------------------------

function evalFrom(prev: HfZone, hf: number) {
  return evaluateThresholds(prev, hf, WARN_AT, ACT_AT);
}

test('healthy to warn emits the warn once', () => {
  const d = evalFrom('healthy', 1.4);
  assert.equal(d.zone, 'warn');
  assert.equal(d.emitWarn, true);
  assert.equal(d.shouldRepair, false);
});

test('warn to warn does not repeat the warn', () => {
  const d = evalFrom('warn', 1.35);
  assert.equal(d.zone, 'warn');
  assert.equal(d.emitWarn, false);
});

test('act to warn (recovering upward) does not warn', () => {
  const d = evalFrom('act', 1.4);
  assert.equal(d.zone, 'warn');
  assert.equal(d.emitWarn, false);
});

test('healthy straight to act repairs without a separate warn', () => {
  const d = evalFrom('healthy', 1.1);
  assert.equal(d.zone, 'act');
  assert.equal(d.emitWarn, false);
  assert.equal(d.shouldRepair, true);
});

test('warn to act repairs', () => {
  const d = evalFrom('warn', 1.25);
  assert.equal(d.zone, 'act');
  assert.equal(d.shouldRepair, true);
});

test('act to act keeps repairing while below the act threshold', () => {
  const d = evalFrom('act', 1.2);
  assert.equal(d.shouldRepair, true);
});

test('warn to healthy recovers silently', () => {
  const d = evalFrom('warn', 1.8);
  assert.equal(d.zone, 'healthy');
  assert.equal(d.emitWarn, false);
  assert.equal(d.shouldRepair, false);
});

test('no debt (Infinity hf) is healthy and never repairs', () => {
  const d = evalFrom('healthy', hfWadToNumber(MAX_UINT256));
  assert.equal(d.zone, 'healthy');
  assert.equal(d.shouldRepair, false);
});
