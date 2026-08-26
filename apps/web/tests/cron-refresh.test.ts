import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Category } from '@agripinaa/agent-index';

import type { ClaimRecord } from '../src/lib/claims';
import { claimedEndpoints, decideCronAccess, runRefresh } from '../src/lib/cron-refresh';

const OPS = 'ops-token-value';
const CRON = 'cron-secret-value';

function access(overrides: {
  opsToken?: string | undefined;
  cronSecret?: string | undefined;
  authorization?: string | null;
}) {
  return decideCronAccess({
    opsToken: 'opsToken' in overrides ? overrides.opsToken : OPS,
    cronSecret: 'cronSecret' in overrides ? overrides.cronSecret : CRON,
    authorization: 'authorization' in overrides ? overrides.authorization! : `Bearer ${OPS}`,
  });
}

function claim(tokenId: string, endpoint: string): ClaimRecord {
  return {
    fields: {
      chainId: 56,
      tokenId,
      description: 'a claimed listing',
      category: 'yield',
      website: '',
      endpoint,
      issuedAt: '2026-08-25T00:00:00.000Z',
    },
    signature: '0xsig',
    signer: '0xowner',
    savedAt: '2026-08-25T00:00:01.000Z',
  };
}

test('the scheduler bearer opens the route, and so does the ops token', () => {
  assert.deepEqual(access({ authorization: `Bearer ${OPS}` }), { ok: true });
  assert.deepEqual(access({ authorization: `Bearer ${CRON}` }), { ok: true });
  // Vercel sends the cron secret and nothing else, so the route has to work
  // with OPS_TOKEN absent.
  assert.deepEqual(access({ opsToken: undefined, authorization: `Bearer ${CRON}` }), { ok: true });
});

test('anything that is not one of the two tokens is unauthorized', () => {
  for (const authorization of [null, '', 'Bearer ', 'Bearer wrong', OPS, `Basic ${OPS}`, `bearer ${OPS}`]) {
    const decision = access({ authorization });
    assert.equal(decision.ok, false, String(authorization));
    assert.equal(decision.ok === false && decision.status, 401, String(authorization));
  }
});

test('with neither token configured the route is closed, not open', () => {
  for (const authorization of [null, 'Bearer ', 'Bearer anything', 'Bearer    ']) {
    const decision = access({ opsToken: undefined, cronSecret: '   ', authorization });
    assert.deepEqual(decision, { ok: false, status: 503, message: 'cron token not configured' });
  }
});

test('only claims that carry an endpoint have anything to probe', () => {
  const records = [claim('1', 'https://one.example'), claim('2', ''), claim('3', '   ')];
  assert.deepEqual(claimedEndpoints(records), [
    { chainId: 56, tokenId: '1', url: 'https://one.example' },
  ]);
});

interface RunOptions {
  claims?: ClaimRecord[];
  probe?: (target: { chainId: number; tokenId: string; url: string }) => Promise<boolean>;
  warmHub?: (category: Category) => Promise<void>;
  budgetMs?: number;
  warmTimeoutMs?: number;
  concurrency?: number;
  clock?: { now: () => number };
}

function run(options: RunOptions = {}) {
  const clock = options.clock ?? { now: () => 1_000 };
  return runRefresh({
    listClaims: async () => options.claims ?? [],
    probe: options.probe ?? (async () => true),
    warmHub: options.warmHub ?? (async () => {}),
    now: () => clock.now(),
    budgetMs: options.budgetMs,
    warmTimeoutMs: options.warmTimeoutMs,
    concurrency: options.concurrency,
  });
}

test('probes every claimed endpoint and counts the ones that answered', async () => {
  const probed: string[] = [];
  const counts = await run({
    claims: [claim('1', 'https://one.example'), claim('2', 'https://two.example'), claim('3', '')],
    probe: async ({ tokenId, url }) => {
      probed.push(url);
      return tokenId === '1';
    },
  });
  assert.deepEqual(probed.sort(), ['https://one.example', 'https://two.example']);
  assert.equal(counts.claimsSeen, 3);
  assert.equal(counts.probed, 2);
  assert.equal(counts.live, 1);
  // Every claim is accounted for: probed, or skipped for want of an endpoint or of time.
  assert.equal(counts.claimsSeen, counts.probed + counts.skipped);
  assert.deepEqual(counts.unfinished, []);
});

test('warms each hub once', async () => {
  const warmed: Category[] = [];
  const counts = await run({
    warmHub: async (category) => {
      warmed.push(category);
    },
  });
  assert.deepEqual(warmed, ['rebalancing', 'grid', 'yield', 'health-factor']);
  assert.equal(counts.warmed, 4);
});

test('runs at most four probes at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const counts = await run({
    claims: Array.from({ length: 12 }, (_, i) => claim(String(i), `https://a${i}.example`)),
    probe: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return true;
    },
  });
  assert.equal(counts.probed, 12);
  assert.equal(peak, 4);
});

test('stops probing when the budget is spent and says what it left', async () => {
  // The clock only moves when a probe runs, so the run is deterministic: with a
  // 50 s budget and 20 s probes, three start and the rest are left. The hubs
  // come after the probes, so a run this far over spends nothing on them.
  let elapsed = 0;
  const counts = await run({
    claims: Array.from({ length: 6 }, (_, i) => claim(String(i), `https://a${i}.example`)),
    probe: async () => {
      elapsed += 20_000;
      return true;
    },
    clock: { now: () => elapsed },
    budgetMs: 50_000,
    concurrency: 1,
  });
  assert.equal(counts.probed, 3);
  assert.equal(counts.skipped, 3);
  assert.equal(counts.claimsSeen, counts.probed + counts.skipped);
  assert.equal(counts.warmed, 0);
  assert.deepEqual(counts.unfinished, [
    '3 claimed endpoints not re-probed within the budget',
    'hub rebalancing not warmed',
    'hub grid not warmed',
    'hub yield not warmed',
    'hub health-factor not warmed',
  ]);
  assert.equal(counts.durationMs, 60_000);
});

test('claimed endpoints are re-probed before any hub is warmed', async () => {
  // Liveness is the half nothing else re-runs: a badge that misses its re-probe
  // decays after 36 h, while an unwarmed hub is one cold page render.
  const order: string[] = [];
  await run({
    claims: [claim('1', 'https://one.example')],
    probe: async () => {
      order.push('probe');
      return true;
    },
    warmHub: async (category) => {
      order.push(`warm ${category}`);
    },
  });
  assert.deepEqual(order, [
    'probe',
    'warm rebalancing',
    'warm grid',
    'warm yield',
    'warm health-factor',
  ]);
});

test('a hub that never answers costs its own cap, not the whole run', async () => {
  // The regression: a warm raced against the entire remaining budget lets one
  // stalled upstream eat the run, and every claimed endpoint goes un-probed.
  const startedAt = Date.now();
  const counts = await run({
    claims: [claim('1', 'https://one.example'), claim('2', 'https://two.example')],
    warmHub: () => new Promise<void>(() => {}),
    clock: { now: () => Date.now() },
    budgetMs: 50_000,
    warmTimeoutMs: 20,
  });
  assert.equal(counts.probed, 2, 'the probes were starved by the warm');
  assert.equal(counts.warmed, 0);
  assert.deepEqual(counts.unfinished, [
    'hub rebalancing not warmed',
    'hub grid not warmed',
    'hub yield not warmed',
    'hub health-factor not warmed',
  ]);
  assert.ok(
    Date.now() - startedAt < 2_000,
    'the run spent the budget on a hub instead of giving up on it',
  );
});

test('a probe that hangs costs its own slot, not the response', async () => {
  const counts = await run({
    claims: [claim('1', 'https://slow.example')],
    probe: () => new Promise<boolean>(() => {}),
    budgetMs: 25,
    concurrency: 1,
  });
  assert.equal(counts.probed, 1);
  assert.equal(counts.live, 0);
  assert.deepEqual(counts.unfinished, ['1 endpoint probe timed out']);
});

test('a failing probe is an answer about that endpoint, not a failed run', async () => {
  const counts = await run({
    claims: [claim('1', 'https://one.example'), claim('2', 'https://two.example')],
    probe: async ({ tokenId }) => {
      if (tokenId === '1') throw new Error('kv write failed');
      return true;
    },
  });
  assert.equal(counts.probed, 2);
  assert.equal(counts.live, 1);
});

test('a hub that will not warm is reported, and the probes still run', async () => {
  const counts = await run({
    claims: [claim('1', 'https://one.example')],
    warmHub: async (category) => {
      if (category === 'grid') throw new Error('upstream 503');
    },
  });
  assert.equal(counts.warmed, 3);
  assert.equal(counts.probed, 1);
  assert.deepEqual(counts.unfinished, ['hub grid not warmed']);
});

test('an unreadable claim index leaves the run reporting zero, not failing', async () => {
  const counts = await runRefresh({
    listClaims: async () => {
      throw new Error('kv unavailable');
    },
    probe: async () => true,
    warmHub: async () => {},
    now: () => 0,
  });
  assert.equal(counts.claimsSeen, 0);
  assert.equal(counts.probed, 0);
  assert.equal(counts.warmed, 4);
  assert.deepEqual(counts.unfinished, ['claims could not be listed']);
});
