import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { verifyPayment, type DecodedPayment, type MerchantConfig } from '@altananetwork/x402-server';
import { FUNDING_FEE_PAYER_BSC } from '@agripinaa/shared';

import { fundingRoutesEnabled, readBody, startX402Server } from '../src/x402-server';

const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const PAYER = '0x2222222222222222222222222222222222222222' as const;
const PAY_TO = '0x3333333333333333333333333333333333333333' as const;
const SPENDER = '0x4444444444444444444444444444444444444444' as const;

test('plain Permit2 is rejected before signature verification because it is not recipient-bound', async () => {
  const payment: DecodedPayment = {
    rail: 'permit2',
    payer: PAYER,
    amount: 1n,
    token: TOKEN,
    signature: '0x12',
    permit: {
      permitted: { token: TOKEN, amount: '1' },
      spender: SPENDER,
      nonce: '1',
      deadline: '2000',
    },
    raw: {},
  };
  const merchant: MerchantConfig = {
    chainId: 56,
    payTo: PAY_TO,
    price: 1n,
    rails: [{
      rail: 'permit2-exact',
      token: { address: TOKEN, name: 'Token', version: '1', symbol: 'TOK', decimals: 18 },
      spender: SPENDER,
    }],
  };
  let signatureChecks = 0;
  const result = await verifyPayment(payment, merchant, {
    now: 1000,
    verifySignature: async () => {
      signatureChecks += 1;
      return true;
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'recipient-bound permit2 witness is required' });
  assert.equal(signatureChecks, 0);
});

test('a local facilitator leaves only public funding routes disabled', () => {
  assert.equal(fundingRoutesEnabled(FUNDING_FEE_PAYER_BSC, true), true);
  assert.equal(fundingRoutesEnabled(FUNDING_FEE_PAYER_BSC, false), false);
  assert.equal(fundingRoutesEnabled(PAYER, true), false);
});

test('merchant body reads fail closed on stalled or oversized uploads', async () => {
  const stalled = new PassThrough();
  await assert.rejects(
    readBody(stalled as never, 64, 10),
    /body read timed out/,
  );
  assert.equal(stalled.destroyed, true);

  const oversized = new PassThrough();
  const result = readBody(oversized as never, 3, 1_000);
  oversized.end('four');
  await assert.rejects(result, /body too large/);
  assert.equal(oversized.destroyed, true);
});

test('the authenticated runner lease serializes grant submissions and releases by token', async (t) => {
  const publicKey = `0x04${'55'.repeat(64)}` as const;
  const server = startX402Server({
    port: 0,
    facilitatorKey: `0x${'11'.repeat(32)}`,
    agents: new Map(),
    managers: new Map([[
      'lease-test',
      {
        master: { publicKey, address: PAY_TO },
        byToken: new Map([['USDT', { publicKey, address: PAY_TO }]]),
      },
    ]]),
    opsToken: 'test-ops-token',
  });
  t.after(() => server.close());
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/internal/session-grant-lease`;
  const input = {
    account: PAYER,
    agent: 'lease-test',
    publicKey,
    leaseToken: `0x${'66'.repeat(32)}`,
    expiry: Math.floor(Date.now() / 1_000) + 3_600,
  };
  const request = (method: 'POST' | 'DELETE', body: typeof input, authorized = true) => fetch(url, {
    method,
    headers: {
      ...(authorized ? { authorization: 'Bearer test-ops-token' } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  assert.equal((await request('POST', input, false)).status, 401);
  assert.equal((await request('POST', input)).status, 201);
  assert.equal((await request('POST', input)).status, 201);
  const other = { ...input, leaseToken: `0x${'77'.repeat(32)}` as const };
  assert.equal((await request('POST', other)).status, 409);
  assert.equal((await request('DELETE', other)).status, 200);
  assert.equal((await request('POST', other)).status, 409);
  assert.equal((await request('DELETE', input)).status, 200);
  assert.equal((await request('POST', other)).status, 201);
});
