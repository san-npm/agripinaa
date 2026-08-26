import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CATEGORIES, type AgentSummary } from '@agripinaa/agent-index';

import type { ClaimRecord } from '../src/lib/claims';
import {
  applyClaim,
  claimForCategory,
  claimProvenanceLabel,
  claimedHubSlots,
} from '../src/lib/claim-merge';

/**
 * Partial records throughout: `applyClaim` reads five fields and must not
 * depend on the rest of a summary, and a claim written by an older build can
 * come back out of KV missing the newer ones.
 */
const bare = {
  tokenId: '297380',
  name: 'Agent #297380',
  description: '',
  category: null,
  claimed: false,
} as unknown as AgentSummary;

test('an owner claim fills description and category', () => {
  const merged = applyClaim(bare, {
    fields: { description: 'Rotates lending venues.', category: 'yield' },
  } as unknown as ClaimRecord);
  assert.equal(merged.description, 'Rotates lending venues.');
  assert.equal(merged.category, 'yield');
  assert.equal(merged.claimed, true);
});

test('no claim leaves the agent untouched', () => {
  assert.equal(applyClaim(bare, null), bare);
});

test('a claim never overwrites on-chain metadata that already exists', () => {
  const rich = {
    ...bare,
    name: 'Real Name',
    description: 'From tokenURI.',
    category: 'grid',
  } as unknown as AgentSummary;
  const merged = applyClaim(rich, {
    fields: { description: 'Owner text.', category: 'yield' },
  } as unknown as ClaimRecord);
  assert.equal(merged.description, 'From tokenURI.');
  assert.equal(merged.category, 'grid');
});

test('a claim names the fields it filled, and leaves the input record alone', () => {
  const merged = applyClaim(bare, {
    fields: { description: 'Rotates lending venues.', category: 'yield' },
  } as unknown as ClaimRecord);
  assert.deepEqual(merged.claimedFields, ['description', 'category']);
  assert.equal(bare.description, '', 'the input agent is not mutated');
});

test('a claimed agent whose metadata already covers a field claims nothing for it', () => {
  const rich = { ...bare, description: 'From tokenURI.' };
  const merged = applyClaim(rich, {
    fields: { description: 'Owner text.', category: 'yield' },
  } as unknown as ClaimRecord);
  assert.deepEqual(merged.claimedFields, ['category']);
  assert.equal(merged.claimed, true, 'a claim still marks the listing as claimed');
});

test('a category of other classifies nothing', () => {
  const merged = applyClaim(bare, {
    fields: { description: 'Does several things.', category: 'other' },
  } as unknown as ClaimRecord);
  assert.equal(merged.category, null);
  assert.deepEqual(merged.claimedFields, ['description']);
});

test('owner links fill a record that carries none', () => {
  const merged = applyClaim(bare, {
    fields: {
      description: '',
      category: 'other',
      website: 'https://example.com',
      endpoint: 'https://example.com/x402',
    },
  } as unknown as ClaimRecord);
  assert.equal(merged.website, 'https://example.com');
  assert.equal(merged.endpoint, 'https://example.com/x402');
  assert.deepEqual(merged.claimedFields, ['website', 'endpoint']);
});

test('the provenance label names the owner-provided fields', () => {
  const merged = applyClaim(bare, {
    fields: { description: 'Rotates lending venues.', category: 'yield' },
  } as unknown as ClaimRecord);
  assert.equal(claimProvenanceLabel(merged), 'owner-provided: description, category');
});

test('an unclaimed agent, and a claim that filled nothing, get no label', () => {
  assert.equal(claimProvenanceLabel(bare), null);
  const rich = {
    ...bare,
    description: 'From tokenURI.',
    category: 'grid',
  } as unknown as AgentSummary;
  const merged = applyClaim(rich, {
    fields: { description: 'Owner text.', category: 'yield' },
  } as unknown as ClaimRecord);
  assert.equal(claimProvenanceLabel(merged), null);
});

test('a hub injects an agent only when its claim supplies the category', () => {
  const claim = {
    fields: { description: 'Owner text.', category: 'yield' },
  } as unknown as ClaimRecord;
  // Nothing indexed for category, so the claim fills it and the hub is right.
  assert.equal(claimForCategory(bare, claim, 'yield')?.category, 'yield');
  assert.equal(claimForCategory(bare, claim, 'grid'), null);

  // Any indexed category makes the record native to an upstream category
  // listing. It must never be injected, including into that same category, or
  // it can appear once now and again when its upstream window is reached.
  const grid = { ...bare, category: 'grid' } as unknown as AgentSummary;
  assert.equal(claimForCategory(grid, claim, 'yield'), null);
  assert.equal(claimForCategory(grid, claim, 'grid'), null);
});

test('a claim of other buys no hub placement at all', () => {
  const claim = {
    fields: { description: 'Does several things.', category: 'other' },
  } as unknown as ClaimRecord;
  for (const category of CATEGORIES) {
    assert.equal(claimForCategory(bare, claim, category), null, category);
  }
});

test('injected claims take at most a third of a hub page', () => {
  // A hub asks for 24: 8 slots for claimed entries, 16 left for the ranked
  // registrations, which is what stops a flood of claims taking the page.
  assert.equal(claimedHubSlots(24), 8);
  assert.equal(claimedHubSlots(45), 15);
  // A page too small to divide still shows one, rather than hiding every claim.
  assert.equal(claimedHubSlots(2), 1);
  assert.equal(claimedHubSlots(0), 1);
});
