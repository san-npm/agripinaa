import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokenLogoKind } from '../src/components/icons';

test('BTCB has its own Bitcoin logo instead of the generic coin fallback', () => {
  assert.equal(tokenLogoKind('BTCB'), 'btcb');
});

test('wrapped BNB intentionally keeps the BNB brand mark', () => {
  assert.equal(tokenLogoKind('WBNB'), 'bnb');
});
