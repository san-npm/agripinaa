import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS } from '@agripinaa/shared/agents';

import { VERIFIED_AGENTS, VERIFIED_IDS, isVerified } from '../src/lib/verified';

/**
 * The verified listing is now projected from the shared registry instead of
 * being a second hand-maintained copy. These pin the four live BSC mainnet ids
 * so the projection cannot quietly drop or rename one.
 */
test('the four live agents are listed, keyed by token id', () => {
  assert.deepEqual(VERIFIED_IDS, ['269703', '269704', '269705', '269706']);
  assert.equal(VERIFIED_AGENTS['269703']?.name, 'Agripinaa Grid');
  assert.equal(VERIFIED_AGENTS['269706']?.category, 'rebalancing');
});

test('each listing carries the registration, attestation, and execution proof', () => {
  for (const record of Object.values(AGENTS)) {
    const listed = VERIFIED_AGENTS[record.tokenId!];
    assert.ok(listed, `${record.slug} is missing from the verified listing`);
    assert.equal(listed.registrationTx, record.registrationTx);
    assert.deepEqual(listed.attestation, record.attestation);
    assert.deepEqual(listed.proofs, record.proofs);
  }
});

test('isVerified is true only for our registered agents', () => {
  assert.equal(isVerified('269703'), true);
  assert.equal(isVerified('269707'), false);
  assert.equal(isVerified('grid'), false);
});
