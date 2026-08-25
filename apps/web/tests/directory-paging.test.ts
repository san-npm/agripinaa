import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSummary } from '@agripinaa/agent-index/types';

import { freshOnLastPage } from '../src/lib/data';

/**
 * The accumulator behind "Load more": every page the visitor has walked is
 * ranked and de-duplicated as one set, and the page renders what the earlier
 * pages did not already show. These fixtures are the two shapes that make that
 * necessary: the same registration coming back on a later page, and a name
 * minted twice across a page boundary.
 */
function agent(over: Partial<AgentSummary> & { tokenId: string }): AgentSummary {
  return {
    id: `56-${over.tokenId}`,
    chainId: 56,
    agentId: `56:0x8004a169:${over.tokenId}`,
    name: `Agent #${over.tokenId}`,
    description: '',
    imageUrl: null,
    owner: '0x1111111111111111111111111111111111111111',
    category: null,
    supportedProtocols: [],
    x402Supported: false,
    registeredAt: null,
    trust: {
      totalScore: null,
      averageScore: null,
      rank: null,
      healthScore: null,
      totalFeedbacks: 0,
      starCount: null,
      isVerified: false,
      source: 'registry',
      asOf: '2026-08-24T00:00:00.000Z',
    },
    ...over,
  };
}

test('a single page comes back ranked by signal quality', () => {
  const bare = agent({ tokenId: '1' });
  const classified = agent({ tokenId: '2', name: 'Harvester', category: 'yield' });
  assert.deepEqual(
    freshOnLastPage([[bare, classified]]).map((a) => a.id),
    ['56-2', '56-1'],
  );
});

test('an agent the first page already showed does not come back on the second', () => {
  const first = agent({ tokenId: '1', name: 'Harvester', category: 'yield' });
  const second = agent({ tokenId: '2', name: 'Ranger', category: 'rebalancing' });
  const fresh = freshOnLastPage([[first], [first, second]]);
  assert.deepEqual(
    fresh.map((a) => a.id),
    ['56-2'],
  );
});

test('a name minted across a page boundary collapses instead of opening a second card', () => {
  // Distinct owners, no category, no score: rankAndDedupe collapses these into
  // one card and picks the newest registration as its face, so the id of the
  // card changes once page two joins the union. Keyed by id alone, that card
  // would read as new and the cluster would be shown twice.
  const early = agent({
    tokenId: '1',
    name: 'Ave.ai',
    owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    registeredAt: '2026-01-01T00:00:00.000Z',
  });
  const late = agent({
    tokenId: '2',
    name: 'Ave.ai',
    owner: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    registeredAt: '2026-02-01T00:00:00.000Z',
  });
  const classified = agent({ tokenId: '3', name: 'Guardian', category: 'health-factor' });

  const firstPage = freshOnLastPage([[early]]);
  assert.deepEqual(firstPage.map((a) => a.id), ['56-1']);

  const secondPage = freshOnLastPage([[early], [late, classified]]);
  assert.deepEqual(
    secondPage.map((a) => a.id),
    ['56-3'],
    'the second Ave.ai registration joins the cluster the first page already showed',
  );
});

test('two agents that share a name but carry real signal both keep their card', () => {
  const first = agent({ tokenId: '1', name: 'Ranger', category: 'rebalancing' });
  const second = agent({
    tokenId: '2',
    name: 'Ranger',
    category: 'rebalancing',
    owner: '0xcccccccccccccccccccccccccccccccccccccccc',
  });
  assert.deepEqual(
    freshOnLastPage([[first], [second]]).map((a) => a.id),
    ['56-2'],
  );
});
