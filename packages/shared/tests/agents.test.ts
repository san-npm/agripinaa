import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST, AGENTS, agentBySlug, agentByTokenId } from '../src/agents';
import { PROOF_AGENTS, PROOF_AGENT_LIST } from '../src/proof';

test('the four live agents are registered with their on-chain ids', () => {
  assert.equal(AGENTS.grid.tokenId, '269703');
  assert.equal(AGENTS['health-factor'].tokenId, '269704');
  assert.equal(AGENTS.yield.tokenId, '269705');
  assert.equal(AGENTS['lp-range'].tokenId, '269706');
});

test('token ids and wallets are unique across agents', () => {
  const ids = AGENT_LIST.map((a) => a.tokenId).filter((id): id is string => id != null);
  const wallets = AGENT_LIST.map((a) => a.wallet.toLowerCase());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(wallets).size, wallets.length);
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

test('registry manifests serialize to the exact bytes the minted tokenURIs resolve to', () => {
  const base = 'https://parity-fixture.example.com';
  for (const agent of AGENT_LIST) {
    const expected = SERVED[agent.slug];
    assert.ok(expected, `${agent.slug}: no captured body to compare against`);
    const served = JSON.stringify({
      ...agent.manifest,
      x402: { endpoint: `${base}/${agent.slug}/status`, ...agent.manifest.x402 },
    });
    assert.equal(served, expected, `${agent.slug} manifest body drifted`);
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
