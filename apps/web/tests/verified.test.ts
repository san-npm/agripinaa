import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS } from '@agripinaa/shared/agents';

import {
  VERIFIED_AGENTS,
  VERIFIED_IDS,
  filterVerified,
  isVerified,
} from '../src/lib/verified';

/**
 * The verified listing is now projected from the shared registry instead of
 * being a second hand-maintained copy. These pin the attested BSC mainnet ids
 * so the projection cannot quietly drop or rename one.
 */
test('the execution-verified agents are listed, keyed by token id', () => {
  assert.deepEqual(VERIFIED_IDS, ['269703', '269704', '269705', '269706', '307486', '307487']);
  assert.equal(VERIFIED_AGENTS['269703']?.name, 'Agripinaa Grid');
  assert.equal(VERIFIED_AGENTS['269706']?.category, 'rebalancing');
  assert.equal(VERIFIED_AGENTS['307486']?.name, 'Agripinaa Venus Guardian');
  assert.equal(VERIFIED_AGENTS['307487']?.name, 'Agripinaa Steward');
});

test('each listing carries the registration, attestation, and execution proof', () => {
  for (const record of Object.values(AGENTS)) {
    if (record.tokenId == null || record.attestation == null) continue;
    const listed = VERIFIED_AGENTS[record.tokenId];
    assert.ok(listed, `${record.slug} is missing from the verified listing`);
    assert.equal(listed.registrationTx, record.registrationTx);
    assert.deepEqual(listed.attestation, record.attestation);
    assert.deepEqual(listed.proofs, record.proofs);
  }
});

test('registration without execution attestation earns no verified badge', () => {
  const unattested = Object.values(AGENTS).filter(
    (record) => record.tokenId != null && record.attestation == null,
  );
  assert.deepEqual(unattested.map((record) => record.tokenId), ['307485', '307488']);
  for (const record of unattested) {
    assert.equal(isVerified(record.tokenId!), false);
    assert.ok(
      !Object.values(VERIFIED_AGENTS).some((listed) => listed.name === record.name),
      `${record.slug} appears in the verified listing`,
    );
  }
});

test('verified surfaces exclude registered first-party agents without an attestation', () => {
  const firstParty = [
    { tokenId: '269703', name: 'Agripinaa Grid' },
    { tokenId: '307485', name: 'Agripinaa BTC Grid' },
    { tokenId: '307486', name: 'Agripinaa Venus Guardian' },
    { tokenId: '307488', name: 'Agripinaa Rebalancer' },
  ];

  assert.deepEqual(
    filterVerified(firstParty).map((agent) => agent.tokenId),
    ['269703', '307486'],
  );
});

test('isVerified is true only for our registered agents', () => {
  assert.equal(isVerified('269703'), true);
  assert.equal(isVerified('307486'), true);
  assert.equal(isVerified('307487'), true);
  assert.equal(isVerified('269707'), false);
  assert.equal(isVerified('grid'), false);
});
