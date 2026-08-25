import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST, AGENTS, agentBySlug, agentByTokenId, pinnedManagerKeyAddress } from '../src/agents';
import { MANAGED_TOKENS } from '../src/contracts';
import { PROOF_AGENTS, PROOF_AGENT_LIST } from '../src/proof';

test('the four live agents are registered with their on-chain ids', () => {
  assert.equal(AGENTS.grid.tokenId, '269703');
  assert.equal(AGENTS['health-factor'].tokenId, '269704');
  assert.equal(AGENTS.yield.tokenId, '269705');
  assert.equal(AGENTS['lp-range'].tokenId, '269706');
});

test('token ids and wallets are unique across agents', () => {
  // Both are null until an agent is registered and its key generated, which is
  // a legitimate state, so uniqueness is asserted over what has been assigned.
  const ids = AGENT_LIST.map((a) => a.tokenId).filter((id): id is string => id != null);
  const wallets = AGENT_LIST.map((a) => a.wallet)
    .filter((w): w is `0x${string}` => w != null)
    .map((w) => w.toLowerCase());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(wallets).size, wallets.length);
});

test('an agent with a token id always has the wallet that minted it', () => {
  // The reverse is fine (configured before funding), but an identity with no
  // wallet would have no execution history to attribute to it.
  for (const agent of AGENT_LIST) {
    if (agent.tokenId != null) assert.ok(agent.wallet, `${agent.slug} has a token id but no wallet`);
  }
});

test('every agent carries a manifest with a category matching its record', () => {
  for (const a of AGENT_LIST) {
    assert.equal(a.manifest.category, a.category, `${a.slug} manifest category`);
    assert.ok(a.manifest.description.length > 40, `${a.slug} description`);
  }
});

test('lookup helpers agree with the record map', () => {
  assert.equal(agentBySlug('grid')?.tokenId, '269703');
  assert.equal(agentByTokenId('269705')?.slug, 'yield');
  assert.equal(agentBySlug('nope'), undefined);
});

/**
 * The slug reaching this helper comes off a URL or a form field on the web
 * side, and a plain object answers `constructor` and `__proto__` from its
 * prototype. A truthy answer there reads as "this agent exists" to every
 * caller that gates on it, so the lookup must see only own keys.
 */
test('a prototype key is not an agent', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(agentBySlug(key), undefined, key);
    assert.equal(pinnedManagerKeyAddress(key, 'USDT'), undefined, key);
  }
});

/**
 * Byte-for-byte lock on the served manifests.
 *
 * The bodies below are the exact responses `/manifests/<slug>.json` returned
 * before the registry existed, captured from a production build with the
 * runner base pinned to the fixture origin. Those URLs are the tokenURI of an
 * already-minted, immutable ERC-8004 identity, so the bytes may not drift:
 * not a value, not a key, not the order of the keys. The composition below
 * mirrors buildManifest (endpoint first inside x402, everything else in
 * declaration order), so this fails the moment a registry edit would change
 * what an x402 client reads back.
 *
 * Only REGISTERED agents are pinned here. An agent still in configuration has
 * no minted tokenURI to hold still for, and pinning its bytes would forbid the
 * tuning it exists to receive; the test below it checks such a body is whole
 * instead. Its bytes get captured here when Task 17 mints it.
 */
const SERVED: Record<string, string> = {
  grid:
    '{"name":"Agripinaa Grid","description":"Mean-reversion grid trader on the WBNB/USDT pair. Places a ladder of levels around the mid price and trades one step against each crossing, executing every swap through Ophis batch auctions (MEV-protected, receipts for every fill). Halts itself on trend breakouts and daily loss limits.","category":"grid","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["trading","x402-status"],"execution":{"venue":"ophis","pair":"WBNB/USDT","chainId":56},"safety":{"maxTradesPerDay":12,"perTradeClipUsd":2,"lossHaltPct":5,"trendHaltBandPct":6},"x402":{"endpoint":"https://parity-fixture.example.com/grid/status","priceUsdt":"0.05","note":"live"}}',
  'health-factor':
    '{"name":"Agripinaa Guardian","description":"Liquidation protection for lending positions. Watches the position\'s health factor around the clock and repays debt from a pre-approved budget through an Altana session key (contract allowlist, daily spend cap, expiry) before liquidation can trigger. Repay and supply only: it can never borrow or withdraw.","category":"health-factor","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["session-keys","monitoring","x402-status"],"execution":{"protocol":"lending","chainId":56},"safety":{"actions":["repay","supply"],"warnHF":1.5,"actHF":1.3,"targetHF":1.6},"recommendedScope":{"spendCapUsdtPerDay":"25","expiresHours":168},"x402":{"endpoint":"https://parity-fixture.example.com/health-factor/status","priceUsdt":"0.05","note":"live"}}',
  yield:
    '{"name":"Agripinaa Harvester","description":"Stablecoin yield rotation across BSC lending venues. Compares live supply rates and moves deposits only when the better venue wins by more than 50 bps on two consecutive checks (no churn on noise). Same asset in, same asset out, venue allowlist enforced.","category":"yield","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["session-keys","x402-status"],"execution":{"asset":"USDT","chainId":56},"safety":{"maxMovesPerDay":1,"hysteresisBps":50,"confirmations":2},"x402":{"endpoint":"https://parity-fixture.example.com/yield/status","priceUsdt":"0.05","note":"live"}}',
  'lp-range':
    '{"name":"Agripinaa Ranger","description":"Concentrated-liquidity range management on PancakeSwap V3 (WBNB/USDT). Detects when the position drifts out of range, collects and closes it, rebalances inventory 50/50 through an Ophis batch auction, and re-mints a fresh range around the current tick. Fee-bleed guard caps rebalances per day and week.","category":"rebalancing","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["trading","lp-management","x402-status"],"execution":{"venue":"pancakeswap-v3","rebalanceVenue":"ophis","pair":"WBNB/USDT","chainId":56},"safety":{"rangePct":5,"outOfRangeMinutes":30,"maxRebalancesPerDay":2,"maxRebalancesPerWeek":4},"x402":{"endpoint":"https://parity-fixture.example.com/lp-range/status","priceUsdt":"0.05","note":"live"}}',
};

const FIXTURE_BASE = 'https://parity-fixture.example.com';

/** How the route composes a served body: endpoint first inside x402. */
function serve(agent: (typeof AGENT_LIST)[number]): string {
  return JSON.stringify({
    ...agent.manifest,
    x402: { endpoint: `${FIXTURE_BASE}/${agent.slug}/status`, ...agent.manifest.x402 },
  });
}

test('registry manifests serialize to the exact bytes the minted tokenURIs resolve to', () => {
  const registered = AGENT_LIST.filter((a) => a.tokenId != null);
  assert.equal(registered.length, 4, 'a newly registered agent needs its bytes captured here');
  for (const agent of registered) {
    const expected = SERVED[agent.slug];
    assert.ok(expected, `${agent.slug}: no captured body to compare against`);
    assert.equal(serve(agent), expected, `${agent.slug} manifest body drifted`);
  }
});

test('an agent still in configuration serves a whole manifest body', () => {
  // Nothing is minted against these yet, so there are no bytes to hold still.
  // What must hold is that the body is complete and self-consistent before a
  // registration turns its URL into a permanent tokenURI: register.ts matches
  // the served name against the record, and a hirer reads the rest of it.
  for (const agent of AGENT_LIST.filter((a) => a.tokenId == null)) {
    const served = JSON.parse(serve(agent)) as {
      name: string;
      description: string;
      category: string;
      image: string;
      capabilities: string[];
      execution: { chainId: number };
      safety: Record<string, unknown>;
      x402: Record<string, unknown>;
    };
    assert.equal(served.name, agent.name, `${agent.slug} name`);
    assert.equal(served.category, agent.category, `${agent.slug} category`);
    assert.ok(served.description.length > 40, `${agent.slug} description`);
    assert.ok(served.image.startsWith('https://'), `${agent.slug} image`);
    assert.ok(served.capabilities.length > 0, `${agent.slug} capabilities`);
    assert.equal(served.execution.chainId, 56, `${agent.slug} chain`);
    assert.ok(Object.keys(served.safety).length > 0, `${agent.slug} safety`);
    // Same key order the route produces, so the captured bytes at registration
    // time will match what is served afterwards.
    assert.equal(Object.keys(served.x402)[0], 'endpoint', `${agent.slug} x402 key order`);
    assert.equal(served.x402['endpoint'], `${FIXTURE_BASE}/${agent.slug}/status`);
  }
});

test('the proof feed is derived from the registry, registered agents only', () => {
  const registered = AGENT_LIST.filter((a) => a.tokenId != null);
  assert.equal(PROOF_AGENT_LIST.length, registered.length);
  for (const agent of registered) {
    const proofAgent = PROOF_AGENTS[agent.slug];
    assert.ok(proofAgent, `${agent.slug} missing from PROOF_AGENTS`);
    assert.equal(proofAgent.tokenId, agent.tokenId);
    assert.equal(proofAgent.name, agent.name);
    assert.equal(proofAgent.category, agent.category);
    assert.equal(proofAgent.wallet, agent.wallet);
    assert.equal(proofAgent.backfillOphisTrades, agent.backfillOphisTrades);
  }
});

test('manager-key pins sit only on managed agents, one distinct address per managed token', () => {
  // A pin is what the browser checks a runner-reported manager key against
  // before that key becomes a session grantee. Only an agent that can hold a
  // mandate has one to pin, and two agents (or two tokens) never share a key.
  const seen: string[] = [];
  for (const agent of AGENT_LIST) {
    const pins = Object.entries(agent.managerKeys ?? {});
    if (!agent.managed) assert.equal(pins.length, 0, `${agent.slug} is not managed but pins a manager key`);
    for (const [token, address] of pins) {
      assert.ok((MANAGED_TOKENS as readonly string[]).includes(token), `${agent.slug} pins unmanaged token ${token}`);
      assert.match(address, /^0x[0-9a-fA-F]{40}$/, `${agent.slug}/${token} pin is not an address`);
      seen.push(address.toLowerCase());
    }
  }
  assert.equal(new Set(seen).size, seen.length, 'two pins share one address');
});

test('the Harvester pins the manager key each managed token grants to', () => {
  // Captured 2026-08-25 from GET <runnerBase>/yield/manager-key?token=<t>,
  // the same path the web proxy reads; USDT is the master key, USDC derived.
  assert.equal(pinnedManagerKeyAddress('yield', 'USDT'), '0x94Fb3dD927a7Bc17cEc1C6D8281A861Ffe76D8B6');
  assert.equal(pinnedManagerKeyAddress('yield', 'USDC'), '0x38A5a310beE9C278BDAFF8E5783Dc0890ab2dfC1');
  // The Steward's session key is not generated yet, so it has nothing to pin;
  // an absent pin is the documented state until Task 17 captures it.
  assert.equal(pinnedManagerKeyAddress('yield-b', 'USDT'), undefined);
  assert.equal(pinnedManagerKeyAddress('nope', 'USDT'), undefined);
});

test('every managed agent that is registered on chain carries its manager-key pins', () => {
  // The gate this holds up: apps/web/src/lib/manager-key.ts refuses a runner
  // report for a registered agent it has no pin for, because a registered
  // agent is one a visitor can reach an activate page for. Registering a
  // managed agent without capturing its pins here would take its activate page
  // down rather than hand a mandate to whatever key the runner reported, and
  // this fails first so that never ships.
  for (const agent of AGENT_LIST) {
    if (!agent.managed || agent.tokenId == null) continue;
    const pins = Object.keys(agent.managerKeys ?? {});
    assert.ok(
      pins.length > 0,
      `${agent.slug} is registered and managed with no pinned manager key: generate its session key and capture the addresses the runner reports`,
    );
    for (const token of MANAGED_TOKENS) {
      assert.ok(pins.includes(token), `${agent.slug} pins no ${token} manager key`);
    }
  }
});
