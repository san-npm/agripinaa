import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSummary } from '@agripinaa/agent-index';

import {
  mergeAttestation,
  trustProvenanceLabel,
} from '../src/lib/attestation-merge';

const agent: AgentSummary = {
  id: '56-269703',
  chainId: 56,
  tokenId: '269703',
  agentId: '56:0x8004a1690000000000000000000000000000000a:269703',
  name: 'Agripinaa Grid',
  description: 'Mean-reversion grid trader.',
  imageUrl: null,
  owner: '0x0000000000000000000000000000000000000001',
  category: 'grid',
  supportedProtocols: [],
  x402Supported: true,
  registeredAt: null,
  trust: {
    totalScore: 0,
    averageScore: null,
    rank: 7,
    healthScore: null,
    totalFeedbacks: 0,
    starCount: null,
    isVerified: false,
    source: '8004scan',
    asOf: '2026-08-24T00:00:00.000Z',
  },
};

test('on-chain attestation wins over a lagging indexer score', () => {
  const merged = mergeAttestation(agent, { value: 100, count: 1 });
  assert.equal(merged.trust.totalScore, 100);
  assert.equal(merged.trust.totalFeedbacks, 1);
});

test('merging keeps the rest of the trust record intact', () => {
  const merged = mergeAttestation(agent, { value: 100, count: 1 });
  assert.equal(merged.trust.rank, 7);
  assert.equal(merged.trust.source, '8004scan');
  assert.equal(merged.tokenId, '269703');
  assert.equal(agent.trust.totalScore, 0, 'the input agent is not mutated');
});

test('a missing attestation leaves the agent untouched', () => {
  assert.equal(mergeAttestation(agent, null), agent);
});

test('an overridden score is tagged as coming from the registry', () => {
  const merged = mergeAttestation(agent, { value: 100, count: 1 });
  assert.equal(merged.trust.scoreSource, 'registry');
  assert.equal(
    merged.trust.source,
    '8004scan',
    'the record still came from the indexer; only the score moved',
  );
});

test('an unmerged record claims no separate score provenance', () => {
  assert.equal(agent.trust.scoreSource, undefined);
  assert.equal(trustProvenanceLabel(agent.trust), '8004scan');
});

test('the provenance label names both sources once they differ', () => {
  const merged = mergeAttestation(agent, { value: 100, count: 1 });
  assert.equal(
    trustProvenanceLabel(merged.trust),
    'registry (score) · 8004scan (profile)',
  );
});

test('the label collapses when both sources agree', () => {
  const fromRegistry: AgentSummary = {
    ...agent,
    trust: { ...agent.trust, source: 'registry' },
  };
  const merged = mergeAttestation(fromRegistry, { value: 100, count: 1 });
  assert.equal(trustProvenanceLabel(merged.trust), 'registry');
});
