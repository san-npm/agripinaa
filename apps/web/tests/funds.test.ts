import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROUTER_ACTIONS, YIELD_ROUTERS_BSC } from '@agripinaa/shared/contracts';

import { decodeRotationRows, formatStableAmount, type RotationLogLike } from '../src/lib/funds';

const ACCOUNT = '0x1111111111111111111111111111111111111111';

function rotationLog(over: Partial<{
  account: string;
  action: string;
  amount: bigint;
  block: bigint;
  logIndex: number;
  tx: string;
}> = {}): RotationLogLike {
  return {
    args: {
      account: over.account ?? ACCOUNT,
      action: over.action ?? ROUTER_ACTIONS.toAave.selector,
      usdtAmount: over.amount ?? BigInt(0),
    },
    transactionHash: over.tx ?? '0xdeadbeef',
    blockNumber: over.block ?? BigInt(1),
    logIndex: over.logIndex ?? 0,
  };
}

test('each router selector decodes to the move it made', () => {
  const rows = decodeRotationRows(
    [
      rotationLog({ action: ROUTER_ACTIONS.toAave.selector, block: BigInt(3) }),
      rotationLog({ action: ROUTER_ACTIONS.toVenus.selector, block: BigInt(2) }),
      rotationLog({ action: ROUTER_ACTIONS.toIdle.selector, block: BigInt(1) }),
    ],
    new Map(),
  );
  assert.deepEqual(
    rows.map((r) => r.action),
    ['Moved into Aave', 'Moved into Venus', 'Unwound to idle'],
  );
});

test('a selector the page does not know still renders a row', () => {
  const [row] = decodeRotationRows([rotationLog({ action: '0x12345678' })], new Map());
  assert.equal(row?.action, 'Rotation');
  assert.equal(row?.account, ACCOUNT);
});

test('rows come back newest first and carry the timestamp of their block', () => {
  const rows = decodeRotationRows(
    [
      rotationLog({ block: BigInt(10), logIndex: 1, tx: '0xa' }),
      rotationLog({ block: BigInt(12), logIndex: 0, tx: '0xb' }),
      rotationLog({ block: BigInt(10), logIndex: 4, tx: '0xc' }),
    ],
    new Map([[BigInt(12), 1_756_000_000]]),
  );
  assert.deepEqual(
    rows.map((r) => r.txHash),
    ['0xb', '0xc', '0xa'],
  );
  assert.equal(rows[0]?.at, new Date(1_756_000_000_000).toISOString());
  assert.equal(rows[1]?.at, null);
  assert.deepEqual(
    rows.map((r) => r.blockNumber),
    ['12', '10', '10'],
  );
  // The panel keys rows on block plus log index, so both have to survive.
  assert.deepEqual(
    rows.map((r) => r.logIndex),
    [0, 4, 1],
  );
});

test('amounts are grouped and rounded to cents without a locale', () => {
  assert.equal(formatStableAmount(BigInt(0)), '0.00');
  assert.equal(formatStableAmount(BigInt('1000000000000000000')), '1.00');
  assert.equal(formatStableAmount(BigInt('1234567891234567890123')), '1,234.57');
  assert.equal(formatStableAmount(BigInt('4999999999999999')), '0.00');
  assert.equal(formatStableAmount(BigInt('5000000000000000')), '0.01');
  assert.equal(formatStableAmount(BigInt('999999999999999999999999')), '1,000,000.00');
});

test('every router deployment states the day it went live', () => {
  // The funds page prints this date next to each address, so a deployment
  // added without one would put a blank where the reader expects a date.
  for (const router of YIELD_ROUTERS_BSC) {
    assert.match(router.deployedOn, /^\d{4}-\d{2}-\d{2}$/, `${router.symbol} has no deployedOn`);
  }
});
