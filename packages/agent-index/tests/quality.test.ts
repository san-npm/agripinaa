import assert from 'node:assert/strict';
import { test } from 'node:test';

import { qualityScore, rankAndDedupe } from '../src/quality';
import type { AgentSummary } from '../src/types';

function agent(
  over: Partial<Omit<AgentSummary, 'trust'>> & {
    tokenId: string;
    trust?: Partial<AgentSummary['trust']>;
  },
): AgentSummary {
  return {
    id: `56-${over.tokenId}`,
    chainId: 56,
    tokenId: over.tokenId,
    agentId: `56:0x8004:${over.tokenId}`,
    name: over.name ?? 'Agent',
    description: over.description ?? '',
    imageUrl: over.imageUrl ?? null,
    owner: over.owner ?? '0xowner',
    category: over.category ?? null,
    supportedProtocols: [],
    x402Supported: over.x402Supported ?? false,
    registeredAt: over.registeredAt ?? null,
    trust: {
      totalScore: over.trust?.totalScore ?? null,
      averageScore: null,
      rank: null,
      healthScore: null,
      totalFeedbacks: over.trust?.totalFeedbacks ?? 0,
      starCount: null,
      isVerified: over.trust?.isVerified ?? false,
      source: '8004scan',
      asOf: '2026-08-19T00:00:00Z',
    },
  };
}

test('categorized + verified agents outrank bare registrations', () => {
  const good = agent({ tokenId: '1', category: 'grid', trust: { isVerified: true, totalScore: 5, totalFeedbacks: 3 } });
  const bare = agent({ tokenId: '2' });
  assert.ok(qualityScore(good) > qualityScore(bare));
});

test('dedupe collapses same name AND owner, keeping the better copy', () => {
  const dupLow = agent({ tokenId: '10', name: 'Ave.ai', owner: '0xA' });
  const dupHigh = agent({ tokenId: '11', name: 'ave.ai', owner: '0xa', category: 'yield' });
  const distinct = agent({ tokenId: '12', name: 'Ave.ai', owner: '0xB' });
  const ranked = rankAndDedupe([dupLow, dupHigh, distinct]);
  // The two 0xA copies collapse to one (the categorized one); 0xB stays.
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.tokenId, '11'); // highest quality first
  assert.ok(ranked.some((a) => a.tokenId === '12'));
  assert.ok(!ranked.some((a) => a.tokenId === '10'));
});

test('flood of identical bare agents collapses to one representative with a count', () => {
  const flood = Array.from({ length: 5 }, (_, i) =>
    agent({ tokenId: `f${i}`, name: 'Spam', owner: `0x${i}`, registeredAt: `2026-08-1${i}` }),
  );
  const real = agent({ tokenId: 'r', name: 'Real', category: 'grid', trust: { totalScore: 9 } });
  const ranked = rankAndDedupe([...flood, real]);
  assert.equal(ranked[0]!.tokenId, 'r'); // evaluable agent leads
  assert.equal(ranked.length, 2); // 5 bare "Spam" collapse to one card
  const spam = ranked.find((a) => a.name === 'Spam');
  assert.equal(spam?.duplicateCount, 5);
});

test('re-ranking an already-collapsed card keeps the count it arrived with', () => {
  const flood = Array.from({ length: 5 }, (_, i) =>
    agent({ tokenId: `f${i}`, name: 'Spam', owner: `0x${i}`, registeredAt: `2026-08-1${i}` }),
  );
  const once = rankAndDedupe(flood);
  // The directory walk ranks each read, then ranks the reads together again.
  const twice = rankAndDedupe(once);
  assert.equal(twice.length, 1);
  assert.equal(twice[0]!.duplicateCount, 5);
});

test('two collapsed cards for one name add their counts up', () => {
  // What the walk holds after two reads: each was collapsed on its own, so
  // neither card knows about the other's registrations.
  const fromReadOne = { ...agent({ tokenId: 'a', name: 'Spam', owner: '0xA' }), duplicateCount: 30 };
  const fromReadTwo = { ...agent({ tokenId: 'b', name: 'spam', owner: '0xB' }), duplicateCount: 25 };
  const ranked = rankAndDedupe([fromReadOne, fromReadTwo]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.duplicateCount, 55);
});

test('a collapsed card absorbing a single new registration counts it', () => {
  const collapsedCard = { ...agent({ tokenId: 'a', name: 'Spam', owner: '0xA' }), duplicateCount: 4 };
  const fresh = agent({ tokenId: 'c', name: 'Spam', owner: '0xC' });
  const ranked = rankAndDedupe([collapsedCard, fresh]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.duplicateCount, 5);
});

test('low-signal agents with distinct names are NOT collapsed', () => {
  const a1 = agent({ tokenId: '1', name: 'Alpha', owner: '0x1' });
  const a2 = agent({ tokenId: '2', name: 'Beta', owner: '0x2' });
  const ranked = rankAndDedupe([a1, a2]);
  assert.equal(ranked.length, 2);
});
