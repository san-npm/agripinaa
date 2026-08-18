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

test('flood of identical bare agents from distinct owners is not merged but sinks below quality', () => {
  const flood = Array.from({ length: 5 }, (_, i) =>
    agent({ tokenId: `f${i}`, name: 'Spam', owner: `0x${i}` }),
  );
  const real = agent({ tokenId: 'r', name: 'Real', category: 'grid', trust: { totalScore: 9 } });
  const ranked = rankAndDedupe([...flood, real]);
  assert.equal(ranked[0]!.tokenId, 'r');
  assert.equal(ranked.length, 6); // distinct owners preserved
});
