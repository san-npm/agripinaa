import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTIVATION_BLOCKED_COPY,
  activationBlockedReason,
  agentConsumesSession,
  isActivatable,
} from '../src/lib/activatable';

/** The input both pages build: liveness probed, session consumption from the registry. */
function inputFor(tokenId: string, endpointLive = false) {
  return { tokenId, endpointLive, consumesSession: agentConsumesSession(tokenId) };
}

test('a first-party agent with a managed path is activatable', () => {
  // 269705 is Agripinaa Harvester, the one registry record with managed: true.
  assert.equal(agentConsumesSession('269705'), true);
  assert.equal(isActivatable(inputFor('269705')), true);
  assert.equal(activationBlockedReason(inputFor('269705')), null);
});

test('a first-party agent with no managed path is not activatable', () => {
  // Grid, Guardian, Ranger. Nothing in apps/agents reads a stored session, so a
  // grant made here would sit unread for its whole expiry window.
  for (const tokenId of ['269703', '269704', '269706']) {
    assert.equal(agentConsumesSession(tokenId), false, tokenId);
    assert.equal(isActivatable(inputFor(tokenId)), false, tokenId);
    assert.equal(activationBlockedReason(inputFor(tokenId)), 'own-capital-only', tokenId);
  }
});

test('owning the agent is not what makes it activatable', () => {
  // The earlier gate asked "is this one of ours?", which is true for all four
  // first-party agents, three of which consume nothing.
  assert.equal(
    isActivatable({ tokenId: '269703', endpointLive: false, consumesSession: false }),
    false,
  );
});

test('a third-party agent needs an endpoint that answered the probe', () => {
  assert.equal(isActivatable(inputFor('999999')), false);
  assert.equal(activationBlockedReason(inputFor('999999')), 'no-live-endpoint');
  // 297380 is a skeletal record from the live index.
  assert.equal(activationBlockedReason(inputFor('297380')), 'no-live-endpoint');
  assert.equal(isActivatable(inputFor('999999', true)), true);
  assert.equal(activationBlockedReason(inputFor('999999', true)), null);
});

test('each blocked reason has copy for what the gate actually checked', () => {
  const ownCapital = ACTIVATION_BLOCKED_COPY['own-capital-only'];
  const noEndpoint = ACTIVATION_BLOCKED_COPY['no-live-endpoint'];
  assert.match(ownCapital.body, /own capital/);
  assert.match(noEndpoint.body, /probe/);
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
