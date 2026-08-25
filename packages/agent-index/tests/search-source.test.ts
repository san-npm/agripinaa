import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MergedSource } from '../src/sources/merged';

/**
 * A search that fails upstream falls back to the committed snapshot, which is a
 * local sample rather than the index. `searchAgents` flattens both into an
 * array, so a caller reading an empty one cannot tell "the index found nothing"
 * from "nothing searched the index", and a directory that renders the second as
 * "no agents match" is stating something it never checked.
 * `searchAgentsWithSource` keeps the two apart.
 */
const BSC = 56;

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function envelope(items: unknown[]): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ success: true, data: items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function scanAgent(tokenId: string, name: string) {
  return {
    agent_id: `56:0x8004a169:${tokenId}`,
    token_id: tokenId,
    chain_id: BSC,
    contract_address: '0x8004a169',
    owner_address: '0x1111111111111111111111111111111111111111',
    name,
    description: '',
    image_url: null,
    is_verified: false,
    star_count: null,
    supported_protocols: null,
    x402_supported: false,
    total_score: null,
    average_score: null,
    rank: null,
    health_score: null,
    total_feedbacks: null,
    created_at: null,
  };
}

test('a search the live index answers is marked as coming from the index', async () => {
  const found = await withFetch(envelope([scanAgent('1', 'Grid Runner')]), () =>
    new MergedSource().searchAgentsWithSource(BSC, 'grid'),
  );
  assert.equal(found.source, 'index');
  assert.deepEqual(
    found.items.map((a) => a.name),
    ['Grid Runner'],
  );
});

test('the index answering with nothing still counts as an answer', async () => {
  const found = await withFetch(envelope([]), () =>
    new MergedSource().searchAgentsWithSource(BSC, 'nothing-matches-this'),
  );
  assert.equal(found.source, 'index');
  assert.deepEqual(found.items, []);
});

test('a rate-limited search is marked as a fallback, not as an empty result', async () => {
  const rateLimited: typeof fetch = async () =>
    new Response('{"error":"rate limit"}', { status: 429 });
  const found = await withFetch(rateLimited, () =>
    new MergedSource().searchAgentsWithSource(BSC, 'grid'),
  );
  assert.equal(found.source, 'fallback');
  // The snapshot answers in its place, so the caller has something to work with
  // even though it cannot read the result as a statement about the index.
  assert.ok(found.items.length > 0);
});

test('an upstream error is marked as a fallback even when the fallback finds nothing', async () => {
  const broken: typeof fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const found = await withFetch(broken, () =>
    new MergedSource().searchAgentsWithSource(BSC, 'zzzz-no-such-agent-zzzz'),
  );
  assert.equal(found.source, 'fallback');
  assert.deepEqual(found.items, []);
});

test('searchAgents still hands back the plain array the source interface promises', async () => {
  const items = await withFetch(envelope([scanAgent('1', 'Grid Runner')]), () =>
    new MergedSource().searchAgents(BSC, 'grid'),
  );
  assert.deepEqual(
    items.map((a) => a.name),
    ['Grid Runner'],
  );
});
