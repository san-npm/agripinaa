import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectQuorumValue, transactionReceiptFingerprint } from '../src/quorum-client';

test('RPC quorum accepts two matching independent responses', () => {
  assert.deepEqual(
    selectQuorumValue([{ balance: 10n }, { balance: 9n }, { balance: 10n }]),
    { balance: 10n },
  );
});

test('one provider cannot forge receipt status or debt-skip logs through quorum', () => {
  const honest = transactionReceiptFingerprint({
    transactionHash: '0x01',
    blockHash: '0xaa',
    blockNumber: 10n,
    status: 'success',
    logs: [],
  });
  const forged = transactionReceiptFingerprint({
    transactionHash: '0x01',
    blockHash: '0xaa',
    blockNumber: 10n,
    status: 'success',
    logs: [{ address: '0xrouter', topics: ['0xencumbered'], data: '0x', logIndex: 0 }],
  });
  assert.deepEqual(selectQuorumValue([forged, honest, honest]), honest);
});

test('RPC quorum fails closed when providers disagree', () => {
  assert.throws(
    () => selectQuorumValue([{ hf: 1.4 }, { hf: 9.9 }, { hf: 0.2 }]),
    /quorum mismatch/,
  );
});
