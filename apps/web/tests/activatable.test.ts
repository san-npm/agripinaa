import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTIVATION_BLOCKED_COPY,
  activationBlockedReason,
  agentConsumesSession,
  isActivatable,
} from '../src/lib/activatable';

/** The input both pages build: liveness probed, session consumption from the registry. */
function inputFor(tokenId: string, endpointLive = false, sessionHandoffSupported = false) {
  return {
    tokenId,
    endpointLive,
    consumesSession: agentConsumesSession(tokenId),
    sessionHandoffSupported,
  };
}

test('all eight first-party policies are activatable', () => {
  for (const tokenId of ['269703', '307485', '269704', '307486', '269705', '307487', '269706', '307488']) {
    assert.equal(agentConsumesSession(tokenId), true, tokenId);
    assert.equal(isActivatable(inputFor(tokenId)), true, tokenId);
    assert.equal(activationBlockedReason(inputFor(tokenId)), null, tokenId);
  }
});

test('owning the agent is not what makes it activatable', () => {
  // The earlier gate asked "is this one of ours?", which is true for all four
  // first-party agents, three of which consume nothing.
  assert.equal(
    isActivatable({
      tokenId: '999999',
      endpointLive: false,
      consumesSession: false,
      sessionHandoffSupported: false,
    }),
    false,
  );
});

test('a third-party agent needs both a live endpoint and a supported handoff', () => {
  assert.equal(isActivatable(inputFor('999999')), false);
  assert.equal(activationBlockedReason(inputFor('999999')), 'no-live-endpoint');
  // 297380 is a skeletal record from the live index.
  assert.equal(activationBlockedReason(inputFor('297380')), 'no-live-endpoint');
  assert.equal(isActivatable(inputFor('999999', true)), false);
  assert.equal(activationBlockedReason(inputFor('999999', true)), 'no-session-handoff');
  assert.equal(isActivatable(inputFor('999999', true, true)), true);
  assert.equal(activationBlockedReason(inputFor('999999', true, true)), null);
});

test('each blocked reason has copy for what the gate actually checked', () => {
  const ownCapital = ACTIVATION_BLOCKED_COPY['own-capital-only'];
  const noEndpoint = ACTIVATION_BLOCKED_COPY['no-live-endpoint'];
  const noHandoff = ACTIVATION_BLOCKED_COPY['no-session-handoff'];
  assert.match(ownCapital.body, /live x402 status/);
  assert.equal(ownCapital.ctaLabel, 'Use live agent');
  assert.match(noEndpoint.body, /probe/);
  assert.match(noHandoff.body, /protocol/);
  for (const copy of Object.values(ACTIVATION_BLOCKED_COPY)) {
    assert.ok(copy.headline.length > 0 && copy.ctaLabel.length > 0);
    // isActivatable reads no claim record, so no branch may assert one.
    assert.doesNotMatch(copy.body, /claim/i);
  }
});

test('blocked copy follows the repo copy rules', () => {
  for (const copy of Object.values(ACTIVATION_BLOCKED_COPY)) {
    for (const line of [copy.headline, copy.body, copy.ctaLabel]) {
      assert.doesNotMatch(line, /[–—]/, `dash in: ${line}`);
      assert.doesNotMatch(line, /\b(honest|genuine|authentic|factual)\b/i, `praise in: ${line}`);
    }
  }
});
