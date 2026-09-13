import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSummary, Page } from '@agripinaa/agent-index';

import { leadWithFirstParty } from '../src/lib/first-party-page';

function agent(tokenId: string): AgentSummary {
  return {
    id: `56-${tokenId}`, chainId: 56, tokenId, agentId: `56:0x8004:${tokenId}`, name: `Agent ${tokenId}`,
    description: '', imageUrl: null, owner: '0x1', category: 'grid', supportedProtocols: [], x402Supported: false,
    registeredAt: null,
    trust: { totalScore: null, averageScore: null, rank: null, healthScore: null, totalFeedbacks: 0, starCount: null, isVerified: false, source: 'the-graph', asOf: '' },
  };
}

test('first-party agents lead the page, duplicates from the window are dropped, and the limit holds', () => {
  const page: Page<AgentSummary> = { items: [agent('9'), agent('269703'), agent('8')], nextCursor: 'g8', total: null, asOf: '', source: 'the-graph' };
  const led = leadWithFirstParty(page, [agent('269703'), agent('307485')], 3);
  assert.deepEqual(led.items.map((a) => a.tokenId), ['269703', '307485', '9']);
  assert.equal(led.nextCursor, 'g8', 'the window cursor is untouched');
  // A token id the window spells differently is still the same agent.
  const spelled = { ...page, items: [{ ...agent('269703'), tokenId: '0269703' }] };
  assert.deepEqual(leadWithFirstParty(spelled, [agent('269703')], 5).items.map((a) => a.tokenId), ['269703']);
});
