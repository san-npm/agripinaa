import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectQuorumValue } from '../src/quorum-client';

test('RPC quorum accepts two matching independent responses', () => {
  assert.deepEqual(
    selectQuorumValue([{ balance: 10n }, { balance: 9n }, { balance: 10n }]),
    { balance: 10n },
  );
});

test('RPC quorum fails closed when providers disagree', () => {
  assert.throws(
    () => selectQuorumValue([{ hf: 1.4 }, { hf: 9.9 }, { hf: 0.2 }]),
    /quorum mismatch/,
  );
});
