/**
 * The agents-side view of the shared registry, plus the two guards that stand
 * in front of operations that cannot be undone: booting a module the registry
 * does not know, and minting a permanent tokenURI against a manifest that does
 * not serve that agent.
 *
 * The funding and URI assertions below are deliberately literal. Four agents
 * are live on BSC mainnet with real balances and already-minted identities, so
 * a refactor that changed an amount or a URL by a character would be a real
 * loss, not a failing expectation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, type AgentRecord } from '@agripinaa/shared';

import {
  FUNDING_PLAN,
  MANAGED_AGENT_SLUGS,
  assertModulesRegistered,
  manifestUrl,
  preflightManifest,
  preflightManifests,
  selectFundingEntries,
} from '../src/agent-config';

test('the funding plan carries the live amounts, keyed by wallet name', () => {
  assert.deepEqual(
    FUNDING_PLAN.map((e) => [e.name, e.bnb, e.usdt, e.wbnb, e.usdc]),
    [
      ['agent-grid', '0.0011', '5', '0.004', '0'],
      ['agent-health-factor', '0.0011', '2', '0.005', '0'],
      ['agent-yield', '0.0009', '2.5', '0', '0'],
      ['agent-lp-range', '0.0011', '1.5', '0.003', '0'],
      ['facilitator', '0.0008', '0', '0', '0'],
    ],
  );
});

test('only the managed agent gets a companion session key', () => {
  assert.deepEqual(
    FUNDING_PLAN.filter((e) => e.sessionKey != null).map((e) => e.sessionKey),
    ['agent-yield-session'],
  );
  assert.deepEqual(MANAGED_AGENT_SLUGS, ['yield']);
});

test('no --only means the whole plan', () => {
  assert.equal(selectFundingEntries(undefined), FUNDING_PLAN);
});

test('--only narrows to the named wallets, in plan order', () => {
  assert.deepEqual(
    selectFundingEntries('agent-grid').map((e) => e.name),
    ['agent-grid'],
  );
  assert.deepEqual(
    selectFundingEntries('facilitator,agent-grid').map((e) => e.name),
    ['agent-grid', 'facilitator'],
  );
  assert.deepEqual(
    selectFundingEntries(' agent-yield , agent-lp-range ').map((e) => e.name),
    ['agent-yield', 'agent-lp-range'],
  );
});

test('--only with an unknown wallet throws instead of funding something else', () => {
  // Funding is not idempotent: silently ignoring a typo would either re-send to
  // every funded wallet or send nothing while reporting success.
  assert.throws(() => selectFundingEntries('agent-grib'), /unknown wallet: agent-grib/);
  assert.throws(() => selectFundingEntries('agent-grid,nope'), /unknown wallet: nope/);
});

test('--only with no list throws', () => {
  assert.throws(() => selectFundingEntries(''), /comma-separated list/);
  assert.throws(() => selectFundingEntries(' , '), /comma-separated list/);
});

test('the runner boot guard accepts the registered strategy slugs', () => {
  assert.doesNotThrow(() =>
    assertModulesRegistered([
      { name: 'grid' },
      { name: 'health-factor' },
      { name: 'yield' },
      { name: 'lp-range' },
    ]),
  );
});

test('the runner boot guard rejects a module with no registry record', () => {
  assert.throws(
    () => assertModulesRegistered([{ name: 'grid' }, { name: 'grid-b' }]),
    /agent module "grid-b" has no record/,
  );
});

test('manifest urls are the ones the minted tokenURIs already point at', () => {
  assert.equal(manifestUrl(AGENTS.grid), 'https://agripinaa.vercel.app/manifests/grid.json');
  assert.equal(
    manifestUrl(AGENTS['health-factor']),
    'https://agripinaa.vercel.app/manifests/health-factor.json',
  );
  assert.equal(manifestUrl(AGENTS.yield), 'https://agripinaa.vercel.app/manifests/yield.json');
  assert.equal(
    manifestUrl(AGENTS['lp-range']),
    'https://agripinaa.vercel.app/manifests/lp-range.json',
  );
});

function serving(body: unknown, status = 200): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify(body), { status });
}

test('the register preflight passes when the served manifest names the agent', async () => {
  await preflightManifest(AGENTS.grid, serving({ name: 'Agripinaa Grid' }));
});

test('the register preflight rejects a manifest whose name does not match', async () => {
  await assert.rejects(
    preflightManifest(AGENTS.grid, serving({ name: 'Agripinaa Ranger' })),
    /says name="Agripinaa Ranger", expected "Agripinaa Grid"/,
  );
  await assert.rejects(
    preflightManifest(AGENTS.grid, serving({})),
    /says name="undefined", expected "Agripinaa Grid"/,
  );
});

test('the register preflight rejects a manifest that is missing or unreadable', async () => {
  await assert.rejects(
    preflightManifest(AGENTS.grid, serving({ name: 'Agripinaa Grid' }, 404)),
    /responded 404; deploy it before registering/,
  );
  await assert.rejects(
    preflightManifest(AGENTS.grid, async () => new Response('<!doctype html>', { status: 200 })),
    /did not parse as JSON/,
  );
  await assert.rejects(
    preflightManifest(AGENTS.grid, async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }),
    /is unreachable \(getaddrinfo ENOTFOUND\)/,
  );
});

test('one bad manifest aborts the whole batch before the next is checked', async () => {
  const seen: string[] = [];
  const records: AgentRecord[] = [AGENTS.grid, AGENTS.yield, AGENTS['lp-range']];
  await assert.rejects(
    preflightManifests(records, async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ name: url.includes('grid') ? 'Agripinaa Grid' : 'x' }));
    }),
    /manifests\/yield\.json says name="x"/,
  );
  assert.deepEqual(seen, [
    'https://agripinaa.vercel.app/manifests/grid.json',
    'https://agripinaa.vercel.app/manifests/yield.json',
  ]);
});
