import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockFingerprint,
  createQuorumPublicClient,
  selectGasPrice,
  selectQuorumValue,
  transactionReceiptFingerprint,
} from '../src/quorum-client';
import { parseAbi, type Block } from 'viem';

test('quorum contract reads, simulations and code reads preserve explicit historical blocks', async (t) => {
  const blocks: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = await new Request(input, init).json() as { id: number; method: string; params: unknown[] };
    if (request.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x64' });
    blocks.push(request.params[1] as string);
    return Response.json({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'eth_getCode' ? '0x1234' : `0x${'00'.repeat(31)}01`,
    });
  });
  const client = createQuorumPublicClient(['https://quorum-a.example', 'https://quorum-b.example']);
  const args = { address: '0x1111111111111111111111111111111111111111' as const,
    abi: parseAbi(['function value() view returns (uint256)']), functionName: 'value' as const, blockNumber: 42n };
  assert.equal(await client.readContract(args), 1n);
  assert.equal((await client.simulateContract(args)).result, 1n);
  assert.equal(await client.getCode(args), '0x1234');
  assert.deepEqual(blocks, Array(6).fill('0x2a'));
});

test('block quorum ignores provider serialization size but still verifies chain state', () => {
  const block = { hash: '0xaa', number: 100n, timestamp: 123n, transactions: [] } as unknown as Block;
  const responses = [66134n, 66135n, 66136n].map((size) => ({ ...block, size }));
  assert.throws(() => selectQuorumValue(responses), /quorum mismatch/);
  assert.deepEqual(selectQuorumValue(responses.map(blockFingerprint)), block);
  assert.throws(() => selectQuorumValue([
    blockFingerprint(responses[0]!),
    blockFingerprint({ ...responses[1]!, timestamp: 456n }),
    blockFingerprint({ ...responses[2]!, hash: '0xbb' }),
  ]), /quorum mismatch/);
});

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

test('gas-price estimates use a median instead of exact equality', () => {
  assert.equal(selectGasPrice([5n, 7n, 6n]), 6n);
  assert.equal(selectGasPrice([5n, 500n, 6n]), 6n, 'one high outlier cannot set the fee');
  assert.equal(selectGasPrice([5n, 6n]), 6n, 'two close answers use the conservative estimate');
  assert.throws(
    () => selectGasPrice([5n, 500n]),
    /exceed 20% spread/,
    'one of two answers cannot set the fee',
  );
  assert.throws(() => selectGasPrice([0n, 5n]), /invalid gas-price estimate/);
  assert.throws(() => selectGasPrice([5n]), /fewer than two/);
});
