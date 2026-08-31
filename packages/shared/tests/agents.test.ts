import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST, AGENTS, agentBySlug, agentByTokenId, pinnedManagerKeyAddress } from '../src/agents';
import { MANAGED_TOKENS } from '../src/contracts';
import { PROOF_AGENTS, PROOF_AGENT_LIST } from '../src/proof';

test('all eight live agents are registered with their on-chain ids', () => {
  assert.equal(AGENTS.grid.tokenId, '269703');
  assert.equal(AGENTS['grid-b'].tokenId, '307485');
  assert.equal(AGENTS['health-factor'].tokenId, '269704');
  assert.equal(AGENTS['venus-guardian'].tokenId, '307486');
  assert.equal(AGENTS.yield.tokenId, '269705');
  assert.equal(AGENTS['yield-b'].tokenId, '307487');
  assert.equal(AGENTS['lp-range'].tokenId, '269706');
  assert.equal(AGENTS['weight-rebalancer'].tokenId, '307488');
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

test('every registered agent publishes a live manifest status', () => {
  for (const agent of AGENT_LIST) {
    if (agent.tokenId == null) continue;
    assert.equal(agent.manifest.x402.note, 'live', `${agent.slug} manifest status`);
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
 * The bodies below are the exact responses `/manifests/<slug>.json` returns
 * after each registered identity has transitioned to live, captured with the
 * runner base pinned to the fixture origin. Those URLs are the tokenURI of an
 * already-minted, immutable ERC-8004 identity, so the bytes may not drift: not
 * a value, not a key, not the order of the keys. The composition below mirrors
 * buildManifest (endpoint first inside x402, everything else in declaration
 * order), so this fails the moment a registry edit would change what an x402
 * client reads back.
 *
 * All first-party agents are registered, so every served body is captured.
 */
const SERVED: Record<string, string> = {
  grid:
    '{"name":"Agripinaa Grid","description":"Mean-reversion grid trader on the WBNB/USDT pair. Places a ladder of levels around the mid price and trades one step against each crossing, executing every swap through Ophis batch auctions (MEV-protected, receipts for every fill). Halts itself on trend breakouts and daily loss limits.","category":"grid","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["trading","x402-status"],"execution":{"venue":"ophis","pair":"WBNB/USDT","chainId":56},"safety":{"maxTradesPerDay":12,"perTradeClipUsd":2,"lossHaltPct":5,"trendHaltBandPct":6},"x402":{"endpoint":"https://parity-fixture.example.com/grid/status","priceUsdt":"0.05","note":"live"}}',
  'grid-b':
    '{"name":"Agripinaa BTC Grid","description":"Mean-reversion grid trader on the BTCB/USDT pair, running a wider and slower ladder than Agripinaa Grid: five levels each side at 2.5 percent spacing, $1.50 clips, 8 trades a day at most, and 45 minutes between fills. Every swap executes through Ophis batch auctions (MEV-protected, a receipt for every fill). Halts itself on a trend breakout and on an inventory drawdown.","category":"grid","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["trading","x402-status"],"execution":{"venue":"ophis","pair":"BTCB/USDT","chainId":56},"safety":{"maxTradesPerDay":8,"perTradeClipUsd":1.5,"minTradeClipUsd":1,"gridSpacingPct":2.5,"levelsPerSide":5,"cooldownMinutes":45,"trendHaltBandPct":6,"lossHaltPct":5,"maxRecentersPerDay":3,"lossHaltBaseline":"inventory value at the first tick, never re-baselined, so the 5 percent floor is cumulative over the agent lifetime rather than daily","onHalt":"trading stops and stays stopped until an operator clears the agent state file; there is no automatic resume"},"x402":{"endpoint":"https://parity-fixture.example.com/grid-b/status","priceUsdt":"0.05","note":"live"}}',
  'health-factor':
    '{"name":"Agripinaa Guardian","description":"Liquidation protection for lending positions. Watches the position\'s health factor around the clock and repays debt from a pre-approved budget through an Altana session key (contract allowlist, daily spend cap, expiry) before liquidation can trigger. Repay and supply only: it can never borrow or withdraw.","category":"health-factor","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["session-keys","monitoring","x402-status"],"execution":{"protocol":"lending","chainId":56},"safety":{"actions":["repay","supply"],"warnHF":1.5,"actHF":1.3,"targetHF":1.6},"recommendedScope":{"spendCapUsdtPerDay":"25","expiresHours":168},"x402":{"endpoint":"https://parity-fixture.example.com/health-factor/status","priceUsdt":"0.05","note":"live"}}',
  'venus-guardian':
    '{"name":"Agripinaa Venus Guardian","description":"Liquidation protection for Venus borrow positions on BSC. Reads collateral, debt, and the live market collateral factor every minute, derives the health factor Venus does not publish, and repays USDT from its own budget to lift the position back to 1.6 before liquidation can trigger. Repay only: it never borrows, never withdraws collateral, and never exits a market.","category":"health-factor","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["monitoring","x402-status"],"execution":{"protocol":"venus","chainId":56},"safety":{"actions":["repay"],"warnHF":1.5,"actHF":1.3,"targetHF":1.6,"maxRepaysPerDay":6,"tickSeconds":60,"healthFactorSource":"derived from collateral value, borrow value and the collateral factor read live from Comptroller.markets on every tick, because Venus reports liquidity and shortfall rather than a ratio; the derivation is cross-checked against that shortfall each tick","onBudgetExhausted":"the agent keeps monitoring and keeps reporting; it never sells or withdraws collateral to fund a repay"},"x402":{"endpoint":"https://parity-fixture.example.com/venus-guardian/status","priceUsdt":"0.05","note":"live"}}',
  yield:
    '{"name":"Agripinaa Harvester","description":"Stablecoin yield rotation across BSC lending venues. Compares live supply rates and moves deposits only when the better venue wins by more than 50 bps on two consecutive checks (no churn on noise). Same asset in, same asset out, venue allowlist enforced.","category":"yield","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["session-keys","x402-status"],"execution":{"asset":"USDT","chainId":56},"safety":{"maxMovesPerDay":1,"hysteresisBps":50,"confirmations":2},"x402":{"endpoint":"https://parity-fixture.example.com/yield/status","priceUsdt":"0.05","note":"live"}}',
  'yield-b':
    '{"name":"Agripinaa Steward","description":"Stablecoin yield rotation across BSC lending venues, run patiently. Compares live Venus and Aave supply rates every twelve hours and moves a deposit only when the other venue leads by 120 bps on three consecutive checks, and never more than once every two days. The same policy applies to its own capital and to every account it manages, and funds move through a router that can only ever pay them back to their owner.","category":"yield","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["session-keys","x402-status"],"execution":{"asset":"USDT","chainId":56},"safety":{"maxMovesPerDay":1,"hysteresisBps":120,"thresholdComparator":"inclusive","confirmations":3,"minHoursBetweenMoves":48,"checkEveryHours":12,"venues":["venus","aave"],"custody":"funds stay in the depositor account throughout; the agent holds a session key scoped to one router whose every recipient is hardcoded to that same account, so it can never send funds anywhere else and never withdraws to itself","onRevoke":"revoking the session stops all further moves; the position stays where it is and the depositor withdraws it themselves"},"recommendedScope":{"spendCapUsdtPerDay":"250","expiresHours":720},"x402":{"endpoint":"https://parity-fixture.example.com/yield-b/status","priceUsdt":"0.05","note":"live"}}',
  'lp-range':
    '{"name":"Agripinaa Ranger","description":"Concentrated-liquidity range management on PancakeSwap V3 (WBNB/USDT). Detects when the position drifts out of range, collects and closes it, rebalances inventory 50/50 through an Ophis batch auction, and re-mints a fresh range around the current tick. Fee-bleed guard caps rebalances per day and week.","category":"rebalancing","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["trading","lp-management","x402-status"],"execution":{"venue":"pancakeswap-v3","rebalanceVenue":"ophis","pair":"WBNB/USDT","chainId":56},"safety":{"rangePct":5,"outOfRangeMinutes":30,"maxRebalancesPerDay":2,"maxRebalancesPerWeek":4},"x402":{"endpoint":"https://parity-fixture.example.com/lp-range/status","priceUsdt":"0.05","note":"live"}}',
  'weight-rebalancer':
    '{"name":"Agripinaa Rebalancer","description":"Portfolio-weight rebalancer holding WBNB and USDT at a 50/50 split by value. Checks the split every 10 minutes and, when drift leaves a 5 percent band, restores the target with a single Ophis batch-auction swap (MEV-protected, a receipt for every rebalance). Sized to the distance from target and no further, so it can neither overdraw a leg nor overshoot into the opposite drift.","category":"rebalancing","image":"https://agripinaa.vercel.app/agent-icon.png","capabilities":["trading","x402-status"],"execution":{"venue":"ophis","pair":"WBNB/USDT","chainId":56},"safety":{"targetWeightPct":50,"driftBandPct":5,"maxRebalancesPerDay":4,"minTradeUsd":1,"cooldownMinutes":35,"tickMinutes":10,"maxTradeSize":"the distance from the target weight, which is at most half the overweight side, never the whole balance","onHalt":"no automatic halt: the agent takes no directional view, so the daily cap, the cooldown and the minimum notional are the limits"},"x402":{"endpoint":"https://parity-fixture.example.com/weight-rebalancer/status","priceUsdt":"0.05","note":"live"}}',
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
  assert.equal(registered.length, 8, 'a newly registered agent needs its bytes captured here');
  for (const agent of registered) {
    const expected = SERVED[agent.slug];
    assert.ok(expected, `${agent.slug}: no captured body to compare against`);
    assert.equal(serve(agent), expected, `${agent.slug} manifest body drifted`);
  }
});

test('no first-party agent remains in configuration-only state', () => {
  assert.deepEqual(AGENT_LIST.filter((agent) => agent.tokenId == null), []);
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

test('each managed agent pins the manager key each managed token grants to', () => {
  // Rotated 2026-08-26; USDT is the master key and USDC is derived.
  assert.equal(pinnedManagerKeyAddress('yield', 'USDT'), '0x085f9F61ff6d65a3632Fe0a4443a33d1E10341a2');
  assert.equal(pinnedManagerKeyAddress('yield', 'USDC'), '0x1A06C18C97B891E4d9F89829E74b08A3e0891646');
  assert.equal(pinnedManagerKeyAddress('yield-b', 'USDT'), '0xFC194cec123CBeb323951813c932800c4A86DD03');
  assert.equal(pinnedManagerKeyAddress('yield-b', 'USDC'), '0xac6a37C49A2875c37f1a70A249D9080482ffF346');
  assert.equal(pinnedManagerKeyAddress('nope', 'USDT'), undefined);
});

test('the stalled Steward grant is pinned as public rotation recovery policy', () => {
  assert.deepEqual(AGENTS['yield-b'].retiredManagerGrants, [{
    token: 'USDT',
    account: '0x47352a5aff2909dcfb46b7f8758c78a868c17988',
    publicKey: '0x04386e48756dfcda04f7dfa42f8bd749506c635392f9854f9220f78f8fa4ad669681b8df925e021af5e462366c43948b7e42522c937b5eeba102fb64c42ae8d941',
    address: '0xB11A2D73C6c52dd0d375785Bfb32B9f1c3E70D01',
    expiry: 1_788_562_703,
    grantCallsId: '0xa17195ab0e796c52ca56e3eb8d899aa0a3b9e3f0ecee7c9ef6141a49f8ba6bf4',
    nonce: '11',
  }]);
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
