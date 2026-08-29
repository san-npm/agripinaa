import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findRelaySessionGrant,
  parseRelayCallStatus,
  parseRelaySessionGrant,
  readRelayCallStatus,
} from '../src/lib/session-relay-recovery';

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

test('classifies direct relay status without treating status 300 as failure', () => {
  assert.deepEqual(parseRelayCallStatus({ result: { id: ID, status: 300, receipts: [] } }, ID), {
    callsId: ID,
    status: 'pending',
  });
  assert.deepEqual(parseRelayCallStatus({
    result: {
      id: ID,
      status: 200,
      receipts: [{ status: '0x1', transactionHash: `0x${'55'.repeat(32)}` }],
    },
  }, ID), {
    callsId: ID,
    status: 'confirmed',
    transactionHash: `0x${'55'.repeat(32)}`,
  });
  assert.deepEqual(parseRelayCallStatus({ result: { id: ID, status: 500 } }, ID), {
    callsId: ID,
    status: 'failed',
  });
  assert.deepEqual(parseRelayCallStatus({
    result: {
      id: ID,
      status: 200,
      receipts: [{ status: '0x0', transactionHash: `0x${'66'.repeat(32)}` }],
    },
  }, ID), {
    callsId: ID,
    status: 'failed',
    transactionHash: `0x${'66'.repeat(32)}`,
  });
  assert.deepEqual(parseRelayCallStatus({ result: { id: ID, status: 200, receipts: [] } }, ID), {
    callsId: ID,
    status: 'pending',
  });
});

test('checks a saved relay id once without entering a long polling loop', async () => {
  let request: RequestInit | undefined;
  const result = await readRelayCallStatus({
    callsId: ID,
    fetcher: async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ result: { id: ID, status: 300, receipts: [] } }));
    },
  });
  assert.equal(result.status, 'pending');
  assert.deepEqual(JSON.parse(String(request?.body)), {
    jsonrpc: '2.0',
    id: 1,
    method: 'wallet_getCallsStatus',
    params: [ID],
  });
});

test('rechecks relay history receipts before treating a manager grant as usable', async () => {
  const responses = [
    history(200),
    {
      result: {
        id: ID,
        status: 200,
        receipts: [{ status: '0x0', transactionHash: `0x${'55'.repeat(32)}` }],
      },
    },
  ];
  const grant = await findRelaySessionGrant({
    account: ACCOUNT,
    publicKey: KEY,
    fetcher: async () => new Response(JSON.stringify(responses.shift())),
  });
  assert.equal(grant, null);
  assert.equal(responses.length, 0);
});
