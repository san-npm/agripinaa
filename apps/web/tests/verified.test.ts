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
    if (record.tokenId == null) continue; // configured, not yet registered
    const listed = VERIFIED_AGENTS[record.tokenId];
    assert.ok(listed, `${record.slug} is missing from the verified listing`);
    assert.equal(listed.registrationTx, record.registrationTx);
    assert.deepEqual(listed.attestation, record.attestation);
    assert.deepEqual(listed.proofs, record.proofs);
  }
});

test('an agent that is only configured earns no verified badge', () => {
  // Adding a record must not put a badge on the marketplace before the
  // on-chain artifacts that badge stands for exist.
  const configured = Object.values(AGENTS).filter((record) => record.tokenId == null);
  assert.ok(configured.length > 0, 'no unregistered agent to check');
  assert.equal(VERIFIED_IDS.length, Object.values(AGENTS).length - configured.length);
  for (const record of configured) {
    assert.equal(isVerified(record.slug), false);
    assert.ok(
      !Object.values(VERIFIED_AGENTS).some((listed) => listed.name === record.name),
      `${record.slug} appears in the verified listing`,
    );
  }
});

test('isVerified is true only for our registered agents', () => {
  assert.equal(isVerified('269703'), true);
  assert.equal(isVerified('269707'), false);
  assert.equal(isVerified('grid'), false);
});
