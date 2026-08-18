import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReputationClient } from '../src/reputation';
import type { ReputationResult } from '../src/reputation';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function assertFailed<T>(result: ReputationResult<T>, status?: number): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, status);
  assert.equal(typeof result.error, 'string');
}

test('every method survives HTTP 530 with ok:false instead of throwing', async () => {
  const { fetch } = fakeFetch(() => new Response('origin down', { status: 530 }));
  const client = new ReputationClient({ fetch });

  assertFailed(await client.enrollAndGetTier('0xAbC0000000000000000000000000000000000001'), 530);
  assertFailed(await client.getXp('0xAbC0000000000000000000000000000000000001'), 530);
  assertFailed(await client.getRank('0xAbC0000000000000000000000000000000000001'), 530);
  assertFailed(await client.getLeaderboard(10), 530);
  assertFailed(await client.getStats(), 530);
});

test('network failure resolves to ok:false with no status', async () => {
  const { fetch } = fakeFetch(() => {
    throw new Error('socket hang up');
  });
  const client = new ReputationClient({ fetch });

  const result = await client.getStats();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, undefined);
    assert.match(result.error, /socket hang up/);
  }
});

test('non-JSON success body resolves to ok:false rather than throwing', async () => {
  const { fetch } = fakeFetch(() => new Response('<html>tier page</html>', { status: 200 }));
  const client = new ReputationClient({ fetch });
  const result = await client.enrollAndGetTier('0xabc');
  assert.equal(result.ok, false);
});

test('enrollAndGetTier lowercases the wallet path and asks for JSON', async () => {
  const tier = {
    wallet: '0x053fff26d28ff4e94dfe862b184f918a50c6f706',
    volume_30d_usd: 1234.5,
    trade_count_30d: 3,
    tier: { name: 'none', min_usd: 0, rebate_pct: 0 },
    next_tier: { name: 'bronze', min_usd: 20000, rebate_pct: 0.1 },
    usd_to_next_tier: 18765.5,
  };
  const { fetch, calls } = fakeFetch(() =>
    new Response(JSON.stringify(tier), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const client = new ReputationClient({ baseUrl: 'https://rebates.test/', fetch });

  const result = await client.enrollAndGetTier('0x053Fff26d28Ff4e94DFE862B184F918A50C6f706');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.tier.name, 'none');
    assert.equal(result.data.volume_30d_usd, 1234.5);
  }
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://rebates.test/tier/0x053fff26d28ff4e94dfe862b184f918a50c6f706');
  assert.equal((call.init?.headers as Record<string, string>).accept, 'application/json');
});

test('getLeaderboard passes the limit through the query string', async () => {
  const { fetch, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ updatedAt: 'now', total: 0, entries: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const client = new ReputationClient({ fetch });

  const result = await client.getLeaderboard(25);
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, 'https://rebates.ophis.fi/leaderboard?limit=25');

  await client.getLeaderboard();
  assert.equal(calls[1]?.url, 'https://rebates.ophis.fi/leaderboard?limit=100');
});
