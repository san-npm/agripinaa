import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { verifyPayment, type DecodedPayment, type MerchantConfig } from '@altananetwork/x402-server';
import { FUNDING_FEE_PAYER_BSC } from '@agripinaa/shared';

import { fundingRoutesEnabled, readBody } from '../src/x402-server';

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
