import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTIVATION_BLOCKED_COPY, isActivatable } from '../src/lib/activatable';

test('first-party agents are activatable', () => {
  assert.equal(isActivatable({ tokenId: '269703', endpointLive: false }), true);
  assert.equal(isActivatable({ tokenId: '269706', endpointLive: false }), true);
});

test('third-party agents need a live probed endpoint', () => {
  assert.equal(isActivatable({ tokenId: '999999', endpointLive: false }), false);
  assert.equal(isActivatable({ tokenId: '999999', endpointLive: true }), true);
});

test('a skeletal registry agent from the live index is not activatable', () => {
  assert.equal(isActivatable({ tokenId: '297380', endpointLive: false }), false);
});

test('the blocked copy says why activation is withheld', () => {
  assert.match(ACTIVATION_BLOCKED_COPY, /cannot act/);
});
