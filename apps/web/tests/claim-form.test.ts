import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLAIM_CATEGORY_OPTIONS, prepareClaim } from '../src/lib/claim-form';

const values = {
  description: 'Rotates USDT between lending venues.',
  category: 'yield' as const,
  website: 'https://example.com',
  endpoint: 'https://example.com/a2a',
};

const issuedAt = '2026-08-25T10:00:00.000Z';

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
