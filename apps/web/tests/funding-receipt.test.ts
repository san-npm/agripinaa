import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TOKENS_BSC } from '@agripinaa/shared';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, type Address } from 'viem';

import { receiptProvesFundingMainBatch } from '../src/lib/funding-receipt';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;
const EVENT = parseAbiItem('event Withdrawal(address indexed src,uint256 wad)');

function withdrawal(src: Address, wad: bigint) {
  return {
    address: TOKENS_BSC.WBNB!.address,
    topics: encodeEventTopics({
      abi: [EVENT],
      eventName: 'Withdrawal',
      args: { src },
    }) as readonly `0x${string}`[],
    data: encodeAbiParameters([{ type: 'uint256' }], [wad]),
  };
}

describe('funding main-batch receipt witness', () => {
  it('accepts only the exact account reserve withdrawal', () => {
    assert.equal(receiptProvesFundingMainBatch([withdrawal(ACCOUNT, 7n)], ACCOUNT, 7n), true);
    assert.equal(receiptProvesFundingMainBatch([withdrawal(ROUTER, 7n)], ACCOUNT, 7n), false);
    assert.equal(receiptProvesFundingMainBatch([withdrawal(ACCOUNT, 6n)], ACCOUNT, 7n), false);
  });

  it('requires no witness when no merchant reserve was acquired', () => {
    assert.equal(receiptProvesFundingMainBatch([], ACCOUNT, 0n), true);
  });
});
