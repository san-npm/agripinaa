import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROUTER_ACTIONS, YIELD_ROUTERS_BSC } from '@agripinaa/shared/contracts';

import {
  decodeRotationRows,
  formatStableAmount,
  parseLogSources,
  underManagementNote,
  type RotationLogLike,
} from '../src/lib/funds';

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
      usdtAmount: over.amount ?? 10n ** 18n,
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

test('zero-value permissionless events are not treated as router activity', () => {
  assert.deepEqual(decodeRotationRows([rotationLog({ amount: 0n })], new Map()), []);
  assert.equal(decodeRotationRows([rotationLog({ amount: 1n })], new Map()).length, 1);
});

test('amounts are grouped and rounded to cents without a locale', () => {
  assert.equal(formatStableAmount(BigInt(0)), '0.00');
  assert.equal(formatStableAmount(BigInt('1000000000000000000')), '1.00');
  assert.equal(formatStableAmount(BigInt('1234567891234567890123')), '1,234.57');
  assert.equal(formatStableAmount(BigInt('4999999999999999')), '0.00');
  assert.equal(formatStableAmount(BigInt('5000000000000000')), '0.01');
  assert.equal(formatStableAmount(BigInt('999999999999999999999999')), '1,000,000.00');
});

test('every router deployment states the block and the day it went live', () => {
  // The funds page prints both next to each address, so a deployment added
  // without them would put a blank where the reader expects a date and block.
  for (const router of YIELD_ROUTERS_BSC) {
    assert.match(router.deployedOn, /^\d{4}-\d{2}-\d{2}$/, `${router.symbol} has no deployedOn`);
    assert.equal(typeof router.deployBlock, 'bigint', `${router.symbol} has no deployBlock`);
    assert.ok(router.deployBlock > BigInt(0), `${router.symbol} deployBlock is not a block`);
  }
});

test('the under-management note only claims a full account set when the scan reached the deployment', () => {
  const deployBlock = '117050416';
  const complete = underManagementNote({ accounts: 1, scannedFrom: deployBlock, deployBlock });
  assert.match(complete, /1 account that used this permissionless router/);

  // Once the floor rises above the deployment block the count is a floor: the
  // note has to name the floor and stop asserting how many accounts exist.
  const partial = underManagementNote({ accounts: 3, scannedFrom: '117200000', deployBlock });
  assert.ok(!partial.includes('this router has rotated,'), partial);
  assert.match(partial, /117,200,000/);
  assert.match(partial, /router activity, not proof of a managed mandate/);
  assert.match(partial, /3 accounts/);

  const partialOne = underManagementNote({ accounts: 1, scannedFrom: '117200000', deployBlock });
  assert.match(partialOne, /1 account/);
});

test('an empty account set is only called empty when the scan reached the deployment', () => {
  const deployBlock = '117231310';
  assert.match(
    underManagementNote({ accounts: 0, scannedFrom: deployBlock, deployBlock }),
    /no nonzero rotation yet/,
  );

  const partial = underManagementNote({ accounts: 0, scannedFrom: '117900000', deployBlock });
  assert.ok(!partial.includes('no nonzero rotation yet'), partial);
  assert.match(partial, /117,900,000/);

  // No scan means no floor to quote, and the panel hides the note anyway.
  assert.match(
    underManagementNote({ accounts: 0, scannedFrom: null, deployBlock }),
    /no nonzero rotation yet/,
  );
});

test('the log endpoints can be replaced from the environment', () => {
  assert.deepEqual(parseLogSources(undefined), []);
  assert.deepEqual(parseLogSources('   '), []);
  assert.deepEqual(
    parseLogSources('https://first.example/v1/key|50000, https://second.example'),
    [
      { url: 'https://first.example/v1/key', maxSpan: BigInt(50000) },
      { url: 'https://second.example', maxSpan: BigInt(9000) },
    ],
  );
  // A span that is not a positive integer falls back to the safe one rather
  // than making every chunk of the scan error.
  assert.deepEqual(parseLogSources('https://third.example|lots'), [
    { url: 'https://third.example', maxSpan: BigInt(9000) },
  ]);
  assert.deepEqual(parseLogSources('https://fourth.example|0'), [
    { url: 'https://fourth.example', maxSpan: BigInt(9000) },
  ]);
  // Anything that is not an http(s) URL is dropped, not rendered as an endpoint.
  assert.deepEqual(parseLogSources('not-a-url, wss://fifth.example, https://sixth.example'), [
    { url: 'https://sixth.example', maxSpan: BigInt(9000) },
  ]);
});
