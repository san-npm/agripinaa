import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLAIM_CATEGORY_OPTIONS, ownerStatus, prepareClaim } from '../src/lib/claim-form';

const values = {
  description: 'Rotates USDT between lending venues.',
  category: 'yield' as const,
  website: 'https://example.com',
  endpoint: 'https://example.com/a2a',
};

const issuedAt = '2026-08-25T10:00:00.000Z';

const OWNER = '0x85115c8ad0f4dc0d84a4d9d0c0a7f0ef0b12f3ff';
const OTHER = '0x1111111111111111111111111111111111111111';

test('prepares the sanitised fields the browser has to sign', () => {
  const { fields } = prepareClaim({ chainId: 56, tokenId: '000297380', values, issuedAt });
  assert.deepEqual(fields, {
    chainId: 56,
    tokenId: '297380',
    description: 'Rotates USDT between lending venues.',
    category: 'yield',
    website: 'https://example.com',
    endpoint: 'https://example.com/a2a',
    issuedAt,
  });
});

test('names the links the sanitiser dropped so the owner is not left guessing', () => {
  const { fields, dropped } = prepareClaim({
    chainId: 56,
    tokenId: '297380',
    values: { ...values, website: 'http://example.com', endpoint: 'https://localhost/a2a' },
    issuedAt,
  });
  assert.deepEqual(dropped, ['website', 'endpoint']);
  assert.equal(fields.website, '');
  assert.equal(fields.endpoint, '');
});

test('a link left blank is not reported as dropped', () => {
  const { dropped } = prepareClaim({
    chainId: 56,
    tokenId: '297380',
    values: { ...values, website: '   ', endpoint: '' },
    issuedAt,
  });
  assert.deepEqual(dropped, []);
});

test('signing the prepared fields again changes nothing', () => {
  const once = prepareClaim({ chainId: 56, tokenId: '297380', values, issuedAt }).fields;
  const twice = prepareClaim({
    chainId: 56,
    tokenId: once.tokenId,
    values: {
      description: once.description,
      category: once.category,
      website: once.website,
      endpoint: once.endpoint,
    },
    issuedAt,
  }).fields;
  assert.deepEqual(twice, once);
});

test('every category the sanitiser accepts is offered by the form', () => {
  const offered = CLAIM_CATEGORY_OPTIONS.map((option) => option.value);
  assert.deepEqual(offered, ['rebalancing', 'grid', 'yield', 'health-factor', 'other']);
  for (const value of offered) {
    const { fields } = prepareClaim({
      chainId: 56,
      tokenId: '297380',
      values: { ...values, category: value },
      issuedAt,
    });
    assert.equal(fields.category, value);
  }
});

test('the owner is recognised whatever case the wallet returns the address in', () => {
  const shouted = `0x${OWNER.slice(2).toUpperCase()}`;
  assert.equal(ownerStatus({ account: shouted, owner: OWNER, ownerFromChain: true }), 'match');
});

test('an account the chain says does not own the agent is refused before signing', () => {
  assert.equal(ownerStatus({ account: OTHER, owner: OWNER, ownerFromChain: true }), 'mismatch');
});

test('a difference from an owner the index supplied is left for the server to answer', () => {
  // The RPC did not answer, so the address on the page can be a transfer
  // behind. Refusing here would lock out the very person the form is for.
  assert.equal(ownerStatus({ account: OTHER, owner: OWNER, ownerFromChain: false }), 'unconfirmed');
});
