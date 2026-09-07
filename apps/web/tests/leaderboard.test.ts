import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatherExecutionRows, rankByExecution, readLeaderboardRecord } from '../src/lib/leaderboard';
import { isManagerSignedOrder, type CowOrder } from '@agripinaa/exec-metrics';
import { AGENT_LIST, type ProofEvent } from '@agripinaa/shared';
import fixture from '../../../packages/exec-metrics/tests/fixtures/order.json';
import { readStrategyActivity } from '../src/lib/strategy-activity';

const rows = [
  { tokenId: '1', name: 'A', fills: 20, avgSurplusBps: 10, firstSeen: '2026-08-01T00:00:00.000Z' },
  { tokenId: '2', name: 'B', fills: 3, avgSurplusBps: 90, firstSeen: '2026-08-20T00:00:00.000Z' },
  { tokenId: '3', name: 'C', fills: 0, avgSurplusBps: 0, firstSeen: '2026-08-22T00:00:00.000Z' },
];

test('agents with no fills rank last and are labelled', () => {
  const ranked = rankByExecution(rows);
  assert.equal(ranked.at(-1)?.tokenId, '3');
  assert.equal(ranked.at(-1)?.unranked, true);
});

test('a thin sample cannot outrank a deep one on average alone', () => {
  const ranked = rankByExecution(rows);
  assert.equal(ranked[0]?.tokenId, '1');
});

test('ranking is stable for identical inputs', () => {
  assert.deepEqual(rankByExecution(rows), rankByExecution(rows));
});

/** Two registered agents plus one still in configuration, which has no record. */
const agents = [
  { tokenId: '1', name: 'A', category: 'grid' as const, wallet: '0xa1' as const },
  { tokenId: '2', name: 'B', category: 'yield' as const, wallet: '0xb2' as const },
  { tokenId: null, name: 'C', category: 'grid' as const, wallet: null },
];

const record = (fills: number, avgSurplusBps: number | null) => ({
  fills,
  avgSurplusBps,
  bestFillBps: avgSurplusBps,
  firstSeen: '2026-08-01T00:00:00.000Z',
});

test('an agent with no token id or no wallet is left out entirely', async () => {
  const rows = await gatherExecutionRows(agents, async () => record(4, 12));
  assert.deepEqual(rows.map((row) => row.tokenId), ['1', '2']);
});

/**
 * /leaderboard is prerendered, so one orderbook failure taking the whole page
 * down takes the build with it. The failing agent has to degrade to a row.
 */
test('one settlement fetch failing leaves the rest of the table standing', async () => {
  const rows = await gatherExecutionRows(agents, async (wallet) => {
    if (wallet === '0xa1') throw new Error('cow orderbook 502');
    return record(4, 12);
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    tokenId: '1',
    name: 'A',
    category: 'grid',
    fills: 0,
    avgSurplusBps: null,
    firstSeen: null,
    unavailable: true,
    managedFills: 0,
    managedUnavailable: false,
  });
  assert.equal(rows[1]?.unavailable, false);
  assert.equal(rows[1]?.fills, 4);
});

test('a fill with missing surplus has no score or rank', () => {
  const [row] = rankByExecution([{ ...rows[0]!, avgSurplusBps: null }]);
  assert.equal(row?.rank, null);
});

test('managed attribution verifies the actual SDK signature and cannot borrow another agent identity', async () => {
  const { signOrder, signerFromPrivateKey } = await import('@altananetwork/sdk');
  // Public synthetic test key, never a deployed wallet or session.
  const signer = signerFromPrivateKey(`0x${'01'.repeat(32)}`);
  const signature = await signOrder({ walletAddress: fixture.owner, signer } as never, fixture.uid.slice(0, 66) as `0x${string}`);
  const order = { ...fixture, signingScheme: 'eip1271', signature } as CowOrder;
  assert.equal(await isManagerSignedOrder(order, [signer.address]), true);
  assert.equal(await isManagerSignedOrder(order, ['0x1111111111111111111111111111111111111111']), false);
  assert.equal(await isManagerSignedOrder({ ...order, buyAmount: '1' }, [signer.address]), false);
  assert.equal(await isManagerSignedOrder({ ...order, owner: signer.address }, [signer.address]), false);
  assert.equal(await isManagerSignedOrder({ ...order, signature: signature.slice(0, -2) + '01' }, [signer.address]), false);
  assert.equal(await isManagerSignedOrder({ ...order, signature: signature.slice(0, 132) + '00'.repeat(33) }, [signer.address]), false);
  assert.equal(await isManagerSignedOrder({ ...order, signingScheme: 'eip712' }, [signer.address]), false);
  const agent = { wallet: '0x1111111111111111111111111111111111111111' as const, managerKeys: { USDT: signer.address } };
  const event = { agent: 'wrong-runner-label', orderUid: order.uid } as ProofEvent;
  let reads = 0;
  const record = await readLeaderboardRecord(agent, [event, event], async () => [], async () => { reads++; return order; });
  assert.equal(reads, 1);
  assert.equal(record.fills, 1);
  assert.equal(record.managedFills, 1);
  const foreign = await readLeaderboardRecord({ ...agent, managerKeys: {} }, [event], async () => [], async () => order);
  assert.equal(foreign.fills, 0);
  const substituted = await readLeaderboardRecord(agent, [{ ...event, orderUid: `0x${'ab'.repeat(56)}` }], async () => [], async () => order);
  assert.equal(substituted.fills, 0);
  const ownOnly = await readLeaderboardRecord({ ...agent, wallet: order.owner as `0x${string}` }, [event], async () => [order], async () => { throw new Error('must not fetch duplicate'); });
  assert.equal(ownOnly.fills, 1);
  assert.equal(ownOnly.managedFills, 0);
  const unavailable = await readLeaderboardRecord(agent, [event], async () => [], async () => { throw new Error('timeout'); });
  assert.equal(unavailable.managedUnavailable, true);
});

test('lending evidence distinguishes success, revert, unavailability and unverified runner attribution', async () => {
  const agent = AGENT_LIST.find(agent => agent.slug === 'yield-b')!;
  const own = await readStrategyActivity(agent, [], async hash => ({ transactionHash: hash, status: 'success', from: agent.wallet! }));
  assert.equal(own.receipts.length, 1);
  assert.equal(own.receipts[0]?.ownWallet, true);
  const failed = await readStrategyActivity(agent, [], async hash => ({ transactionHash: hash, status: 'reverted', from: agent.wallet! }));
  assert.equal(failed.receipts.length, 0);
  const unavailable = await readStrategyActivity(agent, [], async () => { throw new Error('RPC unavailable'); });
  assert.equal(unavailable.unavailable, true);
  const report = await readStrategyActivity(agent, [{ agent: agent.tokenId, txHash: agent.proofs[0]!.ref, kind: 'rotate' } as ProofEvent], async hash => ({ transactionHash: hash, status: 'success', from: '0x1111111111111111111111111111111111111111' }));
  assert.equal(report.receipts[0]?.ownWallet, false);
  const mismatch = await readStrategyActivity(agent, [], async () => ({ transactionHash: `0x${'00'.repeat(32)}`, status: 'success', from: agent.wallet! }));
  assert.equal(mismatch.receipts.length, 0);
});

test('an agent whose settlements could not be read is ranked nowhere', async () => {
  const rows = await gatherExecutionRows(agents, async (wallet) => {
    if (wallet === '0xa1') throw new Error('cow orderbook 502');
    return record(4, 12);
  });
  const ranked = rankByExecution(rows);
  const failed = ranked.find((row) => row.tokenId === '1');
  assert.equal(failed?.unranked, true);
  assert.equal(failed?.rank, null);
  assert.equal(ranked.find((row) => row.tokenId === '2')?.rank, 1);
});

test('every fetch failing still produces a table rather than a rejection', async () => {
  const rows = await gatherExecutionRows(agents, async () => {
    throw new Error('cow orderbook 502');
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.unavailable));
});
