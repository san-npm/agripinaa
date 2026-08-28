import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRelaySessionGrant } from '../src/lib/session-relay-recovery';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const KEY = `0x04${'22'.repeat(64)}` as const;
const ID = `0x${'33'.repeat(32)}` as const;

function history(status: number, executionData = `0xaaaa${KEY.slice(2)}bbbb`) {
  return {
    result: [{
      id: ID,
      status,
      transactions: status === 200
        ? [{ chainId: '0x38', transactionHash: `0x${'55'.repeat(32)}` }]
        : [],
      capabilities: {
        quotes: [{ chainId: '0x38', intent: { eoa: ACCOUNT, executionData } }],
      },
    }],
  };
}

test('finds the exact manager grant in account-wide relay history', () => {
  assert.deepEqual(parseRelaySessionGrant(history(100), ACCOUNT, KEY), {
    callsId: ID,
    status: 'pending',
  });
  assert.deepEqual(parseRelaySessionGrant(history(200), ACCOUNT, KEY), {
    callsId: ID,
    status: 'confirmed',
    transactionHash: `0x${'55'.repeat(32)}`,
  });
});

test('ignores failed and unrelated relay calls', () => {
  assert.equal(parseRelaySessionGrant(history(500), ACCOUNT, KEY), null);
  assert.equal(parseRelaySessionGrant(history(200, `0x${'44'.repeat(80)}`), ACCOUNT, KEY), null);
});

test('fails closed on an unreadable relay response', () => {
  assert.throws(() => parseRelaySessionGrant({}, ACCOUNT, KEY), /unreadable/);
});
