import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRelayConfirmed } from '../src/lib/relay-execution-result';

test('relay failures never claim an on-chain revert or unchanged funds without a receipt', () => {
  const confirmed = { status: 'CONFIRMED' as const };
  assert.equal(assertRelayConfirmed(confirmed, 'Funding preparation'), confirmed);
  for (const status of ['FAILED', 'PENDING'] as const) {
    assert.throws(() => assertRelayConfirmed({ status }, 'Funding preparation'), (error: Error) => {
      assert.match(error.message, /Funding preparation.*relay/);
      assert.doesNotMatch(error.message, /on-chain|No funds were moved/);
      return true;
    });
  }
});
