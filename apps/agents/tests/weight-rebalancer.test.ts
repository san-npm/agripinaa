/**
 * The rebalancer's whole decision is planWeightTrade, so most of this file is
 * about the two ways it can be wrong: acting when it should not (churn, which
 * is how a rebalancer loses money to fees), and acting too hard (a trade larger
 * than the side it sells, or one that crosses the balance point and creates the
 * opposite drift).
 *
 * The last section drives the actual module through a fake chain, so the wiring
 * around that decision is exercised too: band, cooldown, minimum notional,
 * daily cap, and the order they are applied in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';

import { computeRebalanceLeg } from '../src/agents/lp-range';
import {
  BAND_PCT,
  COOLDOWN_MS,
  MAX_REBALANCES_PER_DAY,
  MIN_TRADE_USD,
  TARGET_WEIGHT,
  planWeightTrade,
  weightRebalancerAgent,
} from '../src/agents/weight-rebalancer';
import type { AgentContext } from '../src/types';
import { valueGapUsd } from '../src/value-split';

const WBNB = TOKENS_BSC['WBNB']!;
const USDT = TOKENS_BSC['USDT']!;

const approx = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );

const plan = (baseUsd: number, quoteUsd: number, bandPct = 5) =>
  planWeightTrade({ baseUsd, quoteUsd, targetWeight: 0.5, bandPct });

/* ------------------------------ the decision ----------------------------- */

test('does nothing inside the band', () => {
  const p = plan(51, 49);
  assert.equal(p.side, 'none');
  assert.equal(p.usd, 0);
});

test('the band edge is inclusive, so exactly 5 points still holds', () => {
  // 55/45 is 5 points of drift. Acting at the boundary would make the band one
  // sided and rebalance a book that is exactly as far out as the band allows.
  const held = plan(55, 45);
  assert.equal(held.side, 'none');
  const acted = plan(55.1, 44.9);
  assert.equal(acted.side, 'sell');
});

test('sells the overweight side back to target', () => {
  const p = plan(70, 30);
  assert.equal(p.side, 'sell');
  assert.ok(Math.abs(p.usd - 20) < 0.001, `expected 20, got ${p.usd}`);
});

test('buys the underweight side back to target', () => {
  const p = plan(30, 70);
  assert.equal(p.side, 'buy');
  assert.ok(Math.abs(p.usd - 20) < 0.001, `expected 20, got ${p.usd}`);
});

test('never plans a trade larger than the side it sells', () => {
  const p = plan(100, 0);
  assert.ok(p.usd <= 100);
});

test('the trade is always bounded by the overweight side, at every ratio', () => {
  // The clamp, stated as the property rather than one example: moving more than
  // the heavy side holds is impossible, and so is overshooting the target.
  for (let baseUsd = 0; baseUsd <= 100; baseUsd += 0.5) {
    const quoteUsd = 100 - baseUsd;
    const p = plan(baseUsd, quoteUsd);
    if (p.side === 'none') continue;
    const spending = p.side === 'sell' ? baseUsd : quoteUsd;
    assert.ok(p.usd <= spending, `${p.side} ${p.usd} exceeds the ${spending} it spends`);
    // And it lands exactly on the target rather than past it.
    const after = p.side === 'sell' ? baseUsd - p.usd : baseUsd + p.usd;
    approx(after / 100, 0.5, 1e-9);
  }
});

test('an empty or nonsensical book plans nothing', () => {
  assert.equal(plan(0, 0).side, 'none');
  assert.equal(plan(Number.NaN, 50).side, 'none');
  assert.equal(plan(Number.POSITIVE_INFINITY, 50).side, 'none');
  assert.equal(plan(-10, 50).side, 'none');
});

test('a one-sided book is rebalanced, not refused', () => {
  const allBase = plan(100, 0);
  assert.equal(allBase.side, 'sell');
  approx(allBase.usd, 50);
  const allQuote = plan(0, 100);
  assert.equal(allQuote.side, 'buy');
  approx(allQuote.usd, 50);
});

test('a wider band tolerates more drift, a narrower one less', () => {
  assert.equal(plan(58, 42, 10).side, 'none');
  assert.equal(plan(58, 42, 5).side, 'sell');
  assert.equal(plan(52, 48, 1).side, 'sell');
});

test('it measures value, not token counts, so the price is what moves it', () => {
  // 0.01 WBNB is inside the band at one price and outside it at another.
  const cheap = plan(0.01 * 500, 5.2); // 5.0 vs 5.2
  assert.equal(cheap.side, 'none');
  const rich = plan(0.01 * 900, 5.2); // 9.0 vs 5.2
  assert.equal(rich.side, 'sell');
});

/* ------------------- one implementation, shared with the LP ------------- */

test('at a 50/50 target the shared gap is bit-identical to the halved difference', () => {
  // (base - quote) / 2 is the expression the LP agent computed inline before
  // the extraction, and it sizes that agent's live swaps. Exact equality, not a
  // tolerance: halving is exact in binary floating point and rounding is scale
  // invariant by a power of two, so the two forms agree to the last bit. If
  // this ever stops holding, the extraction moved a live agent's numbers.
  let seed = 20260824;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 2000; i++) {
    const base = next() * 10 ** Math.floor(next() * 9 - 3);
    const quote = next() * 10 ** Math.floor(next() * 9 - 3);
    assert.equal(valueGapUsd(base, quote, 0.5), (base - quote) / 2, `${base} vs ${quote}`);
  }
});

test('the drift math is the same one the LP agent sizes its swaps with', () => {
  // The point of extracting value-split: two agents that disagree about what
  // "50/50" means would report different imbalances for the same wallet.
  for (const [wbnb, usdt, price] of [
    [0.01, 2, 800],
    [0.0025, 8, 800],
    [0, 10, 800],
    [0.031, 7.77, 643.21],
    [1.5, 900.5, 612.34],
  ] as const) {
    const leg = computeRebalanceLeg(wbnb, usdt, price, 0);
    const p = plan(wbnb * price, usdt, 0);
    if (leg === null) {
      assert.equal(p.side, 'none');
      continue;
    }
    assert.equal(p.side, leg.sell === 'WBNB' ? 'sell' : 'buy');
    // Exactly equal, not approximately: at a 0.5 target the two expressions are
    // bit-identical, which is what makes the extraction safe for the live LP
    // agent's swap sizing.
    assert.equal(p.usd, leg.notionalUsd);
  }
});

/* ------------------------- manifest matches the code --------------------- */

test('the published caps are the ones the tick enforces', () => {
  const { safety, execution } = AGENTS['weight-rebalancer'].manifest;
  assert.equal(safety['targetWeightPct'], TARGET_WEIGHT * 100);
  assert.equal(safety['driftBandPct'], BAND_PCT);
  assert.equal(safety['maxRebalancesPerDay'], MAX_REBALANCES_PER_DAY);
  assert.equal(safety['minTradeUsd'], MIN_TRADE_USD);
  assert.equal(safety['cooldownMinutes'], COOLDOWN_MS / 60_000);
  assert.equal(safety['tickMinutes'], weightRebalancerAgent.tickIntervalMs / 60_000);
  assert.equal(execution.pair, 'WBNB/USDT');
  assert.equal(execution.venue, 'ophis');
});

test('the manifest is up front about there being no halt', () => {
  // This agent takes no directional view, so it carries no drawdown halt. That
  // absence belongs in the served manifest rather than being inferred from the
  // presence of one on its sibling agents.
  const { safety } = AGENTS['weight-rebalancer'].manifest;
  assert.match(String(safety['onHalt']), /no automatic halt/);
  assert.match(String(safety['maxTradeSize']), /never the whole balance/);
});

test('the cooldown outlasts an Ophis order, so rebalances cannot stack', () => {
  // The tick is 10 minutes and an order stays executable for about 30, so
  // without this the same side could be sold three more times while the first
  // order was still live.
  assert.ok(COOLDOWN_MS > 30 * 60_000);
  assert.ok(COOLDOWN_MS > weightRebalancerAgent.tickIntervalMs);
});

test('the registry record pins its registered identity and wallet', () => {
  const record = AGENTS['weight-rebalancer'];
  assert.equal(record.tokenId, '307488');
  assert.equal(record.wallet, '0x2516deB9E76995fd7eb0911AacEA441c12ccc98C');
  assert.equal(record.registrationTx, '0xcf6a2d2c86cc72e8c4c02e772ada6be228abaae2136d7f4d5b5a0e69ffbbc77c');
  assert.equal(record.attestation, null);
  assert.deepEqual(record.proofs, []);
  assert.equal(record.category, 'rebalancing');
  assert.equal(record.category, weightRebalancerAgent.category);
  assert.deepEqual(record.funding, { bnb: '0.0015', usdt: '2.5', wbnb: '0.004' });
});

/* ---------------------------------- tick --------------------------------- */

/* The fee-100 WBNB/USDT pool, the deepest of the tiers the core considers. */
const POOL = '0x172fcD41E0913e95784454622d1c3724f546f849';
const PRICE = 640;

interface FakeOpts {
  price?: number;
  wbnbWei?: bigint;
  usdtWei?: bigint;
  allowAction?: boolean;
  initialState?: Record<string, unknown>;
}

function fakeCtx(opts: FakeOpts): {
  ctx: AgentContext;
  logs: Record<string, unknown>[];
  store: Map<string, unknown>;
  swapAttempts: string[];
  allowCalls: string[];
} {
  const store = new Map<string, unknown>(Object.entries(opts.initialState ?? {}));
  const logs: Record<string, unknown>[] = [];
  const swapAttempts: string[] = [];
  const allowCalls: string[] = [];
  const price = opts.price ?? PRICE;
  /* WBNB is token1 in this pool, so slot0 carries USDT per WBNB inverted. */
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(1 / price) * 2 ** 96));

  const publicClient = {
    async readContract(call: { address: string; functionName: string; args?: unknown[] }) {
      const { address, functionName, args } = call;
      if (functionName === 'decimals') {
        swapAttempts.push(address.toLowerCase());
        return Promise.reject(new Error('test stub: swap stopped before the orderbook'));
      }
      if (functionName === 'getPool') {
        return (args![2] as number) === 100 ? POOL : '0x0000000000000000000000000000000000000000';
      }
      if (functionName === 'token0') return USDT.address;
      if (functionName === 'token1') return WBNB.address;
      if (functionName === 'fee') return 100;
      if (functionName === 'liquidity') return BigInt('9294864249557931854010708');
      if (functionName === 'slot0') return [sqrtPriceX96, 0, 0, 0, 0, 0, true];
      if (functionName === 'balanceOf') {
        return address.toLowerCase() === WBNB.address.toLowerCase()
          ? (opts.wbnbWei ?? BigInt(0))
          : (opts.usdtWei ?? BigInt(0));
      }
      throw new Error(`unexpected read ${functionName}@${address}`);
    },
  };

  const ctx = {
    name: 'weight-rebalancer',
    chainId: 56,
    account: { address: '0x000000000000000000000000000000000000dEaD' },
    publicClient,
    walletClient: { chain: { id: 56 } },
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
  return { ctx, logs, store, swapAttempts, allowCalls };
}

/** 0.0125 WBNB is $8 at $640, against $8 of USDT: dead on target. */
const balanced = {
  wbnbWei: toBaseUnits('0.0125', WBNB.decimals),
  usdtWei: toBaseUnits('8', USDT.decimals),
};
/** $12.80 of WBNB against $3.20 of USDT: 80/20, well outside the band. */
const heavyBase = {
  wbnbWei: toBaseUnits('0.02', WBNB.decimals),
  usdtWei: toBaseUnits('3.2', USDT.decimals),
};

test('module export matches the chassis contract', () => {
  assert.equal(weightRebalancerAgent.name, 'weight-rebalancer');
  assert.equal(weightRebalancerAgent.category, 'rebalancing');
  assert.equal(weightRebalancerAgent.tickIntervalMs, 600_000);
  assert.equal(typeof weightRebalancerAgent.tick, 'function');
  assert.equal(typeof weightRebalancerAgent.status, 'function');
});

test('a balanced book ticks without trading and without spending a daily slot', async () => {
  const { ctx, logs, swapAttempts, allowCalls } = fakeCtx(balanced);
  await weightRebalancerAgent.tick(ctx);
  const tick = logs.at(-1)!;
  assert.equal(tick.event, 'tick');
  approx(tick['weight'] as number, 0.5, 1e-6);
  assert.deepEqual(swapAttempts, []);
  assert.deepEqual(allowCalls, [], 'a no-op tick must not consume the daily cap');
});

test('an overweight base sells WBNB, sized to the distance from target', async () => {
  const { ctx, logs, store, swapAttempts } = fakeCtx(heavyBase);
  await weightRebalancerAgent.tick(ctx).catch(() => {
    /* the fake chain stops the swap at the decimals read */
  });

  const intent = logs.find((l) => l.event === 'rebalance-intent');
  assert.ok(intent, `expected a rebalance-intent, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(intent!['side'], 'sell');
  assert.equal(intent!['sellToken'], WBNB.address);
  assert.equal(intent!['buyToken'], USDT.address);
  // (12.80 - 3.20) / 2 = 4.80 of WBNB, which is 0.0075 at $640.
  approx(intent!['notionalUsd'] as number, 4.8, 1e-6);
  approx(Number(intent!['sellAmount']), 0.0075, 1e-7);
  assert.deepEqual(swapAttempts, [WBNB.address.toLowerCase()]);
  // The cooldown anchor persists BEFORE the submit, so a crash in the submit
  // window cannot re-sign the same rebalance against a live order.
  assert.ok(typeof store.get('lastRebalanceAt') === 'number');
});

test('an overweight quote buys WBNB with USDT', async () => {
  const { ctx, logs, swapAttempts } = fakeCtx({
    wbnbWei: toBaseUnits('0.005', WBNB.decimals), // $3.20
    usdtWei: toBaseUnits('12.8', USDT.decimals),
  });
  await weightRebalancerAgent.tick(ctx).catch(() => {});
  const intent = logs.find((l) => l.event === 'rebalance-intent');
  assert.ok(intent);
  assert.equal(intent!['side'], 'buy');
  assert.equal(intent!['sellToken'], USDT.address);
  approx(intent!['notionalUsd'] as number, 4.8, 1e-6);
  assert.equal(intent!['sellAmount'], '4.8');
  assert.deepEqual(swapAttempts, [USDT.address.toLowerCase()]);
});

test('the cooldown blocks a second rebalance and costs no daily slot', async () => {
  const { ctx, logs, swapAttempts, allowCalls } = fakeCtx({
    ...heavyBase,
    initialState: { lastRebalanceAt: Date.now() - 20 * 60_000 },
  });
  await weightRebalancerAgent.tick(ctx);
  const blocked = logs.find((l) => l.event === 'rebalance-blocked');
  assert.ok(blocked);
  assert.equal(blocked!['reason'], 'cooldown');
  assert.deepEqual(swapAttempts, []);
  assert.deepEqual(allowCalls, []);
});

test('a drift worth less than a dollar is not worth a swap', async () => {
  // 60/40 on a $4 book is outside the band but only $0.40 of trade, which the
  // fee would eat. The band and the floor are different limits and both apply.
  const { ctx, logs, swapAttempts } = fakeCtx({
    wbnbWei: toBaseUnits('0.00375', WBNB.decimals), // $2.40
    usdtWei: toBaseUnits('1.6', USDT.decimals),
  });
  await weightRebalancerAgent.tick(ctx);
  const skipped = logs.find((l) => l.event === 'rebalance-skipped');
  assert.ok(skipped, `expected a skip, got ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.equal(skipped!['reason'], 'under-min-notional');
  assert.deepEqual(swapAttempts, []);
});

test('the daily cap stops the fifth rebalance of the day', async () => {
  const { ctx, logs, swapAttempts, allowCalls } = fakeCtx({
    ...heavyBase,
    allowAction: false,
  });
  await weightRebalancerAgent.tick(ctx);
  const skipped = logs.find((l) => l.event === 'rebalance-skipped');
  assert.ok(skipped);
  assert.equal(skipped!['reason'], 'daily-cap');
  assert.deepEqual(allowCalls, ['rebalance']);
  assert.deepEqual(swapAttempts, []);
});

test('status reports the live weight against the target it holds', async () => {
  const { ctx } = fakeCtx(heavyBase);
  const status = (await weightRebalancerAgent.status(ctx)) as {
    pair: string;
    weight: number;
    driftPoints: number;
    targetWeight: number;
    maxRebalancesPerDay: number;
  };
  assert.equal(status.pair, 'WBNB/USDT');
  assert.equal(status.targetWeight, TARGET_WEIGHT);
  approx(status.weight, 0.8, 1e-6);
  approx(status.driftPoints, 30, 1e-4);
  assert.equal(status.maxRebalancesPerDay, MAX_REBALANCES_PER_DAY);
});
