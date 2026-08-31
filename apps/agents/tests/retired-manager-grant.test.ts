import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RetiredManagerGrant } from '@agripinaa/shared';

import {
  retiredGrantFailedAtRelay,
  retiredGrantNonceIsInvalid,
  retiredManagerConflict,
} from '../src/retired-manager-grant';

const GRANT: RetiredManagerGrant = {
  token: 'USDT',
  account: '0x47352a5aff2909dcfb46b7f8758c78a868c17988',
  publicKey: '0x04386e48756dfcda04f7dfa42f8bd749506c635392f9854f9220f78f8fa4ad669681b8df925e021af5e462366c43948b7e42522c937b5eeba102fb64c42ae8d941',
  address: '0xB11A2D73C6c52dd0d375785Bfb32B9f1c3E70D01',
  expiry: 2_000_000_000,
  grantCallsId: '0xa17195ab0e796c52ca56e3eb8d899aa0a3b9e3f0ecee7c9ef6141a49f8ba6bf4',
  nonce: '11',
};

test('nonce invalidation proves the stalled grant can never execute', async () => {
  const client = (current: bigint) => ({ readContract: async () => current });
  assert.equal(await retiredGrantNonceIsInvalid(GRANT, client(11n) as never), false);
  assert.equal(await retiredGrantNonceIsInvalid(GRANT, client(12n) as never), true);
});

test('only an exact failed relay result is final', async () => {
  const response = (id: string, status: number) => async () => new Response(JSON.stringify({ result: { id, status } }));
  assert.equal(await retiredGrantFailedAtRelay(GRANT, response(GRANT.grantCallsId, 300)), false);
  assert.equal(await retiredGrantFailedAtRelay(GRANT, response(GRANT.grantCallsId, 500)), true);
  await assert.rejects(() => retiredGrantFailedAtRelay(GRANT, response(`0x${'aa'.repeat(32)}`, 500)));
});

test('the retired guard accepts only expiry, revoke, nonce invalidation, or relay failure', async () => {
  const base = { account: GRANT.account, managerToken: 'USDT', retired: [GRANT], nowSeconds: 1_900_000_000 };
  const deps = (overrides: Record<string, unknown> = {}) => ({
    isValid: async () => false,
    wasRegistered: async () => false,
    nonceInvalid: async () => false,
    relayFailed: async () => false,
    ...overrides,
  });
  assert.equal(await retiredManagerConflict(base, deps()), true);
  assert.equal(await retiredManagerConflict(base, deps({ isValid: async () => true })), true);
  assert.equal(await retiredManagerConflict(base, deps({ wasRegistered: async () => true })), false);
  assert.equal(await retiredManagerConflict(base, deps({ nonceInvalid: async () => true })), false);
  assert.equal(await retiredManagerConflict(base, deps({ relayFailed: async () => true })), false);
  assert.equal(await retiredManagerConflict({ ...base, nowSeconds: GRANT.expiry }, deps()), false);
});
