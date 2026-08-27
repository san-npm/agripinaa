/**
 * The agents-side view of the shared registry, plus the two guards that stand
 * in front of operations that cannot be undone: booting a module the registry
 * does not know, and minting a permanent tokenURI against a manifest that does
 * not serve that agent.
 *
 * The funding and URI assertions below are deliberately literal. Eight agents
 * are live on BSC mainnet with live balances and already-minted identities, so
 * a refactor that changed an amount or a URL by a character would be an actual
 * loss, not a failing expectation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENTS, type AgentRecord } from '@agripinaa/shared';

import {
  FUNDING_PLAN,
  MANAGED_AGENT_SLUGS,
  assertModulesRegistered,
  isUnprovisioned,
  manifestUrl,
  preflightManifest,
  preflightManifests,
  requiredRunnerWalletFiles,
  selectFundingEntries,
} from '../src/agent-config';

test('the funding plan carries the live amounts, keyed by wallet name', () => {
  // Every ERC20 leg the plan can carry gets a column here, BTCB included. A leg
  // that exists in FundingEntry but is missing from this row is a leg fund.ts
  // can budget, print under --plan, and then never send, which reads as a
  // funded agent right up until its first trade blocks on an empty balance.
  assert.deepEqual(
    FUNDING_PLAN.map((e) => [e.name, e.bnb, e.usdt, e.wbnb, e.usdc, e.btcb]),
    [
      ['agent-grid', '0.0011', '5', '0.004', '0', '0'],
      // One leg per side of BTCB/USDT, because a grid spends both: the buys
      // sell USDT and the sells sell BTCB.
      ['agent-grid-b', '0.0015', '2', '0', '0', '0.000025'],
      ['agent-health-factor', '0.0011', '2', '0.005', '0', '0'],
      // The Venus guardian repays from a USDT budget, and the WBNB leg backs
      // the live borrow position it monitors.
      ['agent-venus-guardian', '0.0015', '2', '0.005', '0', '0'],
      ['agent-yield', '0.0009', '2.5', '0', '0', '0'],
      // yield-b manages user deposits, so its own capital is a token position
      // that gives it a track record of its own.
      ['agent-yield-b', '0.0015', '1', '0', '0', '0'],
      ['agent-lp-range', '0.0011', '1.5', '0.003', '0', '0'],
      ['agent-weight-rebalancer', '0.0015', '2.5', '0.004', '0', '0'],
      ['facilitator', '0.0008', '0', '0', '0', '0'],
    ],
  );
});

test('every managed agent gets its own companion session key', () => {
  assert.deepEqual(
    FUNDING_PLAN.filter((e) => e.sessionKey != null).map((e) => e.sessionKey),
    [
      'agent-grid-session',
      'agent-grid-b-session',
      'agent-health-factor-session',
      'agent-venus-guardian-session',
      'agent-yield-session',
      'agent-yield-b-session',
      'agent-lp-range-session',
      'agent-weight-rebalancer-session',
    ],
  );
  assert.deepEqual(MANAGED_AGENT_SLUGS, [
    'grid',
    'grid-b',
    'health-factor',
    'venus-guardian',
    'yield',
    'yield-b',
    'lp-range',
    'weight-rebalancer',
  ]);
});

test('the runner wallet inventory includes every live agent, manager, and facilitator', () => {
  assert.deepEqual(requiredRunnerWalletFiles(), [
    'facilitator.json',
    'agent-grid.json',
    'agent-grid-session.json',
    'agent-grid-b.json',
    'agent-grid-b-session.json',
    'agent-health-factor.json',
    'agent-health-factor-session.json',
    'agent-venus-guardian.json',
    'agent-venus-guardian-session.json',
    'agent-yield.json',
    'agent-yield-session.json',
    'agent-yield-b.json',
    'agent-yield-b-session.json',
    'agent-lp-range.json',
    'agent-lp-range-session.json',
    'agent-weight-rebalancer.json',
    'agent-weight-rebalancer-session.json',
  ]);
});

test('the runner wallet inventory follows the selected registry revision', () => {
  assert.deepEqual(
    requiredRunnerWalletFiles([
      AGENTS.grid,
      AGENTS.yield,
      { ...AGENTS['grid-b'], wallet: null },
    ]),
    [
      'facilitator.json',
      'agent-grid.json',
      'agent-grid-session.json',
      'agent-yield.json',
      'agent-yield-session.json',
    ],
  );
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
      { name: 'grid-b' },
      { name: 'health-factor' },
      { name: 'yield' },
      { name: 'lp-range' },
    ]),
  );
});

test('the runner boot guard rejects a module with no registry record', () => {
  assert.throws(
    () => assertModulesRegistered([{ name: 'grid' }, { name: 'grid-c' }]),
    /agent module "grid-c" has no record/,
  );
});

test('a registered wallet pin is never treated as configuration-only', () => {
  // The runner skips an unprovisioned agent instead of dying at boot: a record
  // can exist before `fund --gen` creates its key, and one such agent must not
  // take every other agent's tick loop down with it.
  assert.equal(isUnprovisioned({ wallet: null }, false), true);
  assert.equal(isUnprovisioned({ wallet: null }, true), false);
  // A record that names a wallet is provisioned, so a missing key file is a
  // an operational failure and must still surface (buildContext throws on it).
  assert.equal(isUnprovisioned(AGENTS.grid, false), false);
  assert.equal(isUnprovisioned(AGENTS['grid-b'], false), false);
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
