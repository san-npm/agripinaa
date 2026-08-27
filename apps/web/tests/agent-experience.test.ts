import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST } from '@agripinaa/shared/agents';

import { AGENT_EXPERIENCE, agentExperience } from '../src/lib/agent-experience';

test('every first-party agent has hackathon-facing positioning', () => {
  assert.deepEqual(
    Object.keys(AGENT_EXPERIENCE).sort(),
    AGENT_LIST.map((agent) => agent.slug).sort(),
  );
  for (const agent of AGENT_LIST) {
    const copy = agentExperience(agent.slug);
    assert.ok(copy.directoryLabel.length > 0, agent.slug);
    assert.ok(copy.profileCta.length > 0, agent.slug);
    assert.equal(copy.managed != null, agent.managed, agent.slug);
  }
});

test('Harvester and Steward are presented as different managed-yield choices', () => {
  const harvester = agentExperience('yield');
  const steward = agentExperience('yield-b');
  assert.match(harvester.directoryLabel, /Responsive/);
  assert.match(steward.directoryLabel, /Patient/);
  assert.notEqual(harvester.profileCta, steward.profileCta);
  assert.notEqual(harvester.managed?.heading, steward.managed?.heading);
  assert.notEqual(harvester.managed?.submitLabel, steward.managed?.submitLabel);
  assert.match(harvester.managed?.intro ?? '', /50 bps/);
  assert.match(steward.managed?.intro ?? '', /120 bps/);
});

test('the other six expose their own managed strategy, not a generic yield deposit', () => {
  for (const slug of ['grid', 'grid-b', 'health-factor', 'venus-guardian', 'lp-range', 'weight-rebalancer'] as const) {
    const copy = agentExperience(slug);
    assert.match(copy.directoryLabel, /managed|reserve/i);
    assert.match(copy.profileCta, /activate|protect/i);
    assert.ok(copy.managed?.heading);
    assert.doesNotMatch(copy.managed?.intro ?? '', /higher-yielding venue/i);
  }
});
