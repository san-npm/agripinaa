import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST, AGENTS } from '@agripinaa/shared/agents';

import { checkPayTo, decodeChallenge, previewPayload, readStatusAnswer } from '../src/lib/x402-demo';

/**
 * The 402 body the live runner answered for GET /grid/status on 2026-08-25,
 * fetched through the tunnel with no X-PAYMENT header. Every value in it is
 * public: the USDT contract, the Grid agent's own wallet as payTo, and the
 * facilitator's settler address as the Permit2 spender.
 */
const LIVE_GRID_402 = JSON.parse(
  '{"x402Version":2,"error":"payment required","description":"Agripinaa grid agent: live status","accepts":[{"scheme":"exact","network":"eip155:56","asset":"0x55d398326f99059fF775485246999027B3197955","payTo":"0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A","amount":"50000000000000000","maxTimeoutSeconds":300,"extra":{"name":"Tether USD","version":"1","assetTransferMethod":"permit2-exact","spenderAddress":"0x7f922FB740E2036477346f559e5660fA38A2C9E5"}}]}',
) as unknown;

test('the live Grid challenge decodes to what the endpoint asks for', () => {
  const ask = decodeChallenge(LIVE_GRID_402);
  assert.ok(ask);
  assert.equal(ask.description, 'Agripinaa grid agent: live status');
  assert.equal(ask.amount, '50000000000000000');
  // USDT is 18 decimals on BNB Chain, so the atomic amount reads back as 0.05.
  assert.equal(ask.amountFormatted, '0.05 USDT');
  assert.equal(ask.asset, '0x55d398326f99059fF775485246999027B3197955');
  assert.equal(ask.assetSymbol, 'USDT');
  assert.equal(ask.payTo, '0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A');
  assert.equal(ask.network, 'eip155:56');
  assert.equal(ask.chainId, 56);
  assert.equal(ask.rail, 'permit2-exact');
  assert.equal(ask.spender, '0x7f922FB740E2036477346f559e5660fA38A2C9E5');
  assert.equal(ask.timeoutSeconds, 300);
});

test('the permit2-exact option is chosen when a challenge lists several rails', () => {
  const eip3009 = {
    scheme: 'exact',
    network: 'eip155:56',
    asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    payTo: '0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A',
    amount: '50000000000000000',
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
  };
  const body = LIVE_GRID_402 as { accepts: unknown[] };
  const ask = decodeChallenge({ ...body, accepts: [eip3009, ...body.accepts] });
  assert.ok(ask);
  assert.equal(ask.rail, 'permit2-exact');
  assert.equal(ask.assetSymbol, 'USDT');
});

test('an asset outside the token registry keeps its atomic amount and no symbol', () => {
  const body = LIVE_GRID_402 as { accepts: Record<string, unknown>[] };
  const foreign = { ...body.accepts[0], asset: '0x1111111111111111111111111111111111111111' };
  const ask = decodeChallenge({ ...body, accepts: [foreign] });
  assert.ok(ask);
  assert.equal(ask.assetSymbol, null);
  assert.equal(ask.amountFormatted, '50000000000000000 (atomic units)');
});

test('bodies that are not an x402 challenge decode to null', () => {
  for (const body of [
    null,
    'payment required',
    {},
    { accepts: [] },
    { accepts: [{ scheme: 'exact' }] },
    // A malformed payTo must not be shown as an address to pay.
    { accepts: [{ ...(LIVE_GRID_402 as { accepts: Record<string, unknown>[] }).accepts[0], payTo: 'not-an-address' }] },
    { accepts: [{ ...(LIVE_GRID_402 as { accepts: Record<string, unknown>[] }).accepts[0], amount: '0.05' }] },
  ]) {
    assert.equal(decodeChallenge(body), null, JSON.stringify(body));
  }
});

test('the live Grid challenge pays the wallet the registry pins for grid', () => {
  const ask = decodeChallenge(LIVE_GRID_402);
  assert.ok(ask);
  assert.deepEqual(checkPayTo('grid', ask.payTo), { verdict: 'pinned', wallet: AGENTS.grid.wallet });
  // The pin is on the address, not its spelling: a lower-cased payTo still matches.
  assert.equal(checkPayTo('grid', ask.payTo.toLowerCase() as `0x${string}`).verdict, 'pinned');
});

test('a challenge paying any other address is refused and names both wallets', () => {
  // Another first-party wallet is the sharpest case: a valid address, ours,
  // and still not where a payment for grid may go.
  const reported = AGENTS['health-factor'].wallet!;
  assert.deepEqual(checkPayTo('grid', reported), {
    verdict: 'mismatch',
    expected: AGENTS.grid.wallet,
    reported,
  });
  assert.equal(checkPayTo('grid', '0x0000000000000000000000000000000000000000').verdict, 'mismatch');
});

test('the newly provisioned agent pins its own payment destination', () => {
  const wallet = AGENTS['grid-b'].wallet!;
  assert.deepEqual(checkPayTo('grid-b', wallet), { verdict: 'pinned', wallet });
  assert.equal(checkPayTo('grid-b', AGENTS.grid.wallet!).verdict, 'mismatch');
});

test('every first-party agent has a preview in the shape x402-server returns', () => {
  for (const agent of AGENT_LIST) {
    const preview = previewPayload(agent.slug);
    // The envelope x402-server writes after settlement, key for key.
    assert.deepEqual(Object.keys(preview), ['agent', 'category', 'paidBy', 'settlementTx', 'status'], agent.slug);
    assert.equal(preview.agent, agent.slug);
    assert.equal(preview.category, agent.category);
    assert.ok(Object.keys(preview.status).length > 0, `${agent.slug} has an empty status preview`);
    assert.ok('halted' in preview.status, `${agent.slug} preview lacks the breaker flag every status() reports`);
    // Illustrative values only, and JSON-serializable so the panel can print them.
    assert.equal(typeof JSON.stringify(preview), 'string');
  }
});

test('the preview keys of the registered agents match their status() bodies', () => {
  // Pinned by reading apps/agents/src/agents/<slug>.ts status(); a runner
  // change that adds or renames a field should fail here, not drift silently.
  assert.deepEqual(Object.keys(previewPayload('grid').status), [
    'center', 'price', 'levels', 'fills', 'inventoryStartUsd', 'inventoryNowUsd', 'halted',
  ]);
  assert.deepEqual(Object.keys(previewPayload('health-factor').status), [
    'healthFactor', 'warnAt', 'actAt', 'targetAfterRepair', 'collateralBase', 'debtBase',
    'repayBudgetUsdt', 'actionsToday', 'halted',
  ]);
  assert.deepEqual(Object.keys(previewPayload('yield').status), [
    'venue', 'positionUsdt', 'venusApyBps', 'aaveApyBps', 'edgeBps', 'betterStreak', 'movesToday', 'halted',
  ]);
  assert.deepEqual(Object.keys(previewPayload('lp-range').status), [
    'tokenId', 'tickLower', 'tickUpper', 'currentTick', 'inRange', 'outSinceMinutes',
    'rebalancesToday', 'rebalancesThisWeek', 'inventoryPrepsThisWeek', 'weeklyBudgetUsed',
    'weeklyBudgetMax', 'halted',
  ]);
});

/**
 * What the panel does with each answer the server function can hand back. The
 * mapping lives next to the decoding rather than in the component so a state
 * the panel can get stuck in is a test rather than a click.
 */
test('no answer from the runner is one offline state, whatever caused it', () => {
  assert.deepEqual(readStatusAnswer({ kind: 'unreachable' }), { kind: 'offline' });
  assert.deepEqual(readStatusAnswer({ kind: 'timeout' }), { kind: 'offline' });
});

test('an oversized body and an unknown agent each say what happened', () => {
  const oversized = readStatusAnswer({ kind: 'oversized' });
  assert.equal(oversized.kind, 'unexpected');
  const unknown = readStatusAnswer({ kind: 'unknown-agent' });
  assert.equal(unknown.kind, 'unexpected');
});

test('a 402 the page can read becomes the challenge panel', () => {
  const verdict = readStatusAnswer({ kind: 'answered', status: 402, body: LIVE_GRID_402 });
  assert.equal(verdict.kind, 'challenge');
  assert.equal(verdict.kind === 'challenge' && verdict.ask.amountFormatted, '0.05 USDT');
});

test('a 402 the page cannot read is an error, not an empty challenge', () => {
  const verdict = readStatusAnswer({ kind: 'answered', status: 402, body: { accepts: [] } });
  assert.equal(verdict.kind, 'unexpected');
});

test('a 200 carrying a status is the paid panel', () => {
  const verdict = readStatusAnswer({ kind: 'answered', status: 200, body: { halted: false } });
  assert.deepEqual(verdict, { kind: 'paid', payload: { halted: false } });
});

/**
 * The server function passes a body it could not parse on as null. Rendering
 * that in the success panel prints "null" under a green border, which reads as
 * the runner having answered with nothing rather than as a broken answer.
 */
test('a 2xx whose body did not parse is an error state, not an empty success', () => {
  for (const body of [null, undefined]) {
    const verdict = readStatusAnswer({ kind: 'answered', status: 200, body });
    assert.equal(verdict.kind, 'unexpected', String(body));
  }
});

test('any other status is reported with the number the runner sent', () => {
  const verdict = readStatusAnswer({ kind: 'answered', status: 503, body: null });
  assert.equal(verdict.kind, 'unexpected');
  assert.match(verdict.kind === 'unexpected' ? verdict.detail : '', /503/);
});
