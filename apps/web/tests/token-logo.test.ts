import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tokenLogoAsset, tokenLogoKind } from '../src/lib/token-logo-assets';

test('BTCB has its own Bitcoin logo instead of the generic coin fallback', () => {
  assert.equal(tokenLogoKind('BTCB'), 'btcb');
});

test('wrapped BNB intentionally keeps the BNB brand mark', () => {
  assert.equal(tokenLogoKind('WBNB'), 'bnb');
});

test('all four supported assets map to pinned official CryptoLogos SVGs', () => {
  assert.equal(tokenLogoAsset('USDT'), '/tokens/tether-usdt-logo.svg');
  assert.equal(tokenLogoAsset('USDC'), '/tokens/usd-coin-usdc-logo.svg');
  assert.equal(tokenLogoAsset('BNB'), '/tokens/bnb-bnb-logo.svg');
  assert.equal(tokenLogoAsset('WBNB'), '/tokens/bnb-bnb-logo.svg');
  assert.equal(tokenLogoAsset('BTCB'), '/tokens/bitcoin-btc-logo.svg');
});

test('every supported logo path resolves to a bundled public asset', async () => {
  for (const symbol of ['USDT', 'USDC', 'BNB', 'BTCB']) {
    const asset = tokenLogoAsset(symbol);
    assert.ok(asset);
    await access(join(import.meta.dirname, '..', 'public', asset));
  }
});
