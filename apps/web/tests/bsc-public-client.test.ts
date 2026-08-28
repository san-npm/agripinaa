import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BSC_MAINNET } from '@agripinaa/shared/chains';
import type { Hex, TransactionReceipt } from 'viem';

import {
  BSC_RECEIPT_RPC_SOURCES,
  fundingReceiptFingerprint,
  waitForBscTransactionReceipt,
  type BscReceiptClient,
} from '../src/lib/bsc-public-client';

const HASH = '0x279a32de4a34115057efaa71322ef90944335d384bc303638a0d3491811fb91c' as Hex;

function receipt(data = '0x01' as Hex): TransactionReceipt {
  return {
    blockHash: '0x473cc88c00fbb3a7796589a4e88d3e981a7e367e44fd16d4ca176269a82ed05e',
    blockNumber: 118543431n,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    from: '0xDE3136c489B3371de8180D4c94c0238150e2c5b4',
    gasUsed: 1n,
    logs: [{
      address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      blockHash: '0x473cc88c00fbb3a7796589a4e88d3e981a7e367e44fd16d4ca176269a82ed05e',
      blockNumber: 118543431n,
      data,
      logIndex: 1,
      removed: false,
      topics: ['0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'],
      transactionHash: HASH,
      transactionIndex: 1,
    }],
    logsBloom: '0x00',
    status: 'success',
    to: '0xAF140d0416A994Aebb3fA6212B16CE6700f09751',
    transactionHash: HASH,
    transactionIndex: 1,
    type: 'eip1559',
  };
}

function client(result: TransactionReceipt | Error): BscReceiptClient {
  return {
    async getTransactionReceipt() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe('BSC funding receipt quorum', () => {
  it('does not select PublicNode as the browser default', () => {
    assert.notEqual(BSC_MAINNET.rpcUrls[0], 'https://bsc-rpc.publicnode.com');
  });

  it('counts at most one receipt vote per RPC operator', () => {
    assert.ok(BSC_RECEIPT_RPC_SOURCES.length >= 3);
    assert.equal(
      new Set(BSC_RECEIPT_RPC_SOURCES.map(({ operator }) => operator)).size,
      BSC_RECEIPT_RPC_SOURCES.length,
    );
  });

  it('ignores one provider archive refusal when two receipts match', async () => {
    const expected = receipt();
    const actual = await waitForBscTransactionReceipt(HASH, {
      clients: [
        client(new Error('Archive requests require a personal token')),
        client(expected),
        client(receipt()),
      ],
      timeoutMs: 0,
      pollMs: 0,
    });
    assert.equal(fundingReceiptFingerprint(actual), fundingReceiptFingerprint(expected));
  });

  it('ignores one malformed provider response when two receipts match', async () => {
    const expected = receipt();
    const malformed = { ...receipt(), logs: undefined } as unknown as TransactionReceipt;
    const actual = await waitForBscTransactionReceipt(HASH, {
      clients: [client(malformed), client(expected), client(receipt())],
      timeoutMs: 0,
      pollMs: 0,
    });
    assert.equal(fundingReceiptFingerprint(actual), fundingReceiptFingerprint(expected));
  });

  it('fails closed when only one provider returns the receipt', async () => {
    await assert.rejects(
      waitForBscTransactionReceipt(HASH, {
        clients: [client(receipt()), client(new Error('offline')), client(new Error('archive'))],
        timeoutMs: 0,
        pollMs: 0,
      }),
      /two BSC RPC providers have not agreed.*do not deposit again/,
    );
  });

  it('fails closed when providers disagree on the receipt logs', async () => {
    await assert.rejects(
      waitForBscTransactionReceipt(HASH, {
        clients: [client(receipt('0x01')), client(receipt('0x02')), client(new Error('offline'))],
        timeoutMs: 0,
        pollMs: 0,
      }),
      /two BSC RPC providers have not agreed/,
    );
  });
});
