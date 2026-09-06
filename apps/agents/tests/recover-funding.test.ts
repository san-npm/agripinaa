import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ALTANA_ORCHESTRATOR_BSC, FUNDING_FEE_PAYER_BSC } from '@agripinaa/shared';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseAbiParameters, toHex, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fundingAuthorization, fundingReceiptStatus, parseFundingRecovery, prepareFundingRecovery, requireRejectedFunding, submitSavedFunding } from '../src/recover-funding';

const sender = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const user = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const id = `0x${'33'.repeat(32)}` as Hex;
const zero = '0x0000000000000000000000000000000000000000';
const delegation = '0xc0f16888f4198f53892c53af859f673e23f26fa3';
const now = 1_800_000_000_000;
const intent = {
  eoa: user.address, executionData: '0x', nonce: '0x1', payer: FUNDING_FEE_PAYER_BSC,
  paymentToken: zero, paymentMaxAmount: toHex(200_000_000_000_000n), combinedGas: '0x186a0',
  encodedPreCalls: [], encodedFundTransfers: [], settler: zero, expiry: '0x0', isMultichain: false,
  funder: zero, funderSignature: '0x', settlerContext: '0x', paymentAmount: toHex(100_000_000_000_000n),
  paymentRecipient: zero, signature: '0x1234', paymentSignature: `0x${'11'.repeat(65)}`,
  supportedAccountImplementation: '0x4b5d20cd8a3927b500540d9bccddc27385c9fa79',
};
const entry = {
  id, status: 300, timestamp: now / 1_000 - 1, transactions: [],
  capabilities: { quotes: [{ chainId: '0x38', orchestrator: ALTANA_ORCHESTRATOR_BSC,
    authorizationAddress: delegation, txGas: '0x30d40', intent }] },
};

test('recovery accepts only rejected, unbroadcast, recent, bounded BSC funding', () => {
  assert.equal(parseFundingRecovery(entry, user.address, id, now).gas, 200_000n);
  for (const status of [100, 200, 201, 400, 500, 'FAILED', '300', undefined]) {
    assert.throws(() => requireRejectedFunding({ ...entry, status }, id), /status 300/);
  }
  assert.throws(() => requireRejectedFunding({ ...entry, transactions: [{ hash: id }] }, id));
  assert.throws(() => requireRejectedFunding({ ...entry, transactions: undefined }, id));
  assert.throws(() => requireRejectedFunding(entry, `0x${'44'.repeat(32)}`));
  assert.throws(() => parseFundingRecovery(entry, sender.address, id, now));
  assert.throws(() => parseFundingRecovery(entry, user.address, id, now + 24 * 60 * 60_000));
  assert.throws(() => parseFundingRecovery(entry, user.address, id, now - 10_000));
  for (const patch of [
    { payer: sender.address }, { paymentToken: sender.address }, { settler: sender.address },
    { funder: sender.address }, { funderSignature: '0x12' }, { settlerContext: '0x12' },
    { eoa: sender.address }, { supportedAccountImplementation: sender.address },
    { isMultichain: true }, { isMultichain: 'false' }, { paymentSignature: '0x' },
    { signature: '0x' }, { expiry: '0x1' }, { paymentAmount: '0x0' },
    { paymentAmount: toHex(201_000_000_000_000n) }, { paymentMaxAmount: toHex(201_000_000_000_000n) },
    { combinedGas: '0x0' }, { combinedGas: toHex(200_000n) }, { nonce: '-1' },
    { nonce: toHex(2n ** 256n) }, { nonce: toHex(0xc1d0n << 240n) },
    { encodedFundTransfers: ['0x12'] }, { encodedPreCalls: ['0x', '0x', '0x'] },
  ]) {
    const altered = { ...entry, capabilities: { quotes: [{ ...entry.capabilities.quotes[0], intent: { ...intent, ...patch } }] } };
    assert.throws(() => parseFundingRecovery(altered, user.address, id, now), JSON.stringify(patch));
  }
});

test('authorization recovery binds signer, delegation, chain and canonical signature', async () => {
  const signed = await user.signAuthorization({ contractAddress: delegation, chainId: 56, nonce: 0 });
  const raw = { ...signed, chainId: toHex(signed.chainId), nonce: toHex(signed.nonce), yParity: toHex(signed.yParity!) };
  const { v: _v, ...expected } = signed;
  assert.deepEqual(await fundingAuthorization(raw, user.address), expected);
  await assert.rejects(fundingAuthorization(raw, sender.address), /signer/);
  for (const patch of [{ address: zero }, { chainId: '0x1' }, { nonce: toHex(2n ** 64n) },
    { yParity: '0x2' }, { s: `0x${'ff'.repeat(32)}` }, { r: '0x00' }]) {
    await assert.rejects(fundingAuthorization({ ...raw, ...patch }, user.address));
  }
});

test('the user and existing payer cannot be used as the recovery gas wallet', async () => {
  const recovery = parseFundingRecovery(entry, user.address, id, now);
  for (const address of [user.address, FUNDING_FEE_PAYER_BSC, zero] as const) {
    await assert.rejects(prepareFundingRecovery({ client: {} as never, sender: address, recovery, userAuthorization: null }), /separate/);
  }
  await assert.rejects(prepareFundingRecovery({
    client: { getChainId: async () => 1 } as never, sender: sender.address, recovery, userAuthorization: null,
  }), /chain 56/);
});

test('a receipt needs the exact successful Orchestrator event, not just EVM success', () => {
  const abi = parseAbi(['event IntentExecuted(address indexed eoa,uint256 indexed nonce,bool incremented,bytes4 err)']);
  const log = {
    address: ALTANA_ORCHESTRATOR_BSC,
    topics: encodeEventTopics({ abi, eventName: 'IntentExecuted', args: { eoa: user.address, nonce: 1n } }),
    data: encodeAbiParameters(parseAbiParameters('bool,bytes4'), [true, '0x00000000']),
  };
  const receipt = { status: 'success', logs: [log] } as unknown as TransactionReceipt;
  assert.equal(fundingReceiptStatus(receipt, user.address, 1n), 'confirmed');
  assert.equal(fundingReceiptStatus({ ...receipt, status: 'reverted' }, user.address, 1n), 'failed');
  assert.equal(fundingReceiptStatus(receipt, user.address, 2n), 'unknown');
  assert.equal(fundingReceiptStatus(receipt, sender.address, 1n), 'unknown');
  assert.equal(fundingReceiptStatus({ ...receipt, logs: [] }, user.address, 1n), 'unknown');
  for (const [incremented, err] of [[false, '0x00000000'], [true, '0xabab8fc9']] as const) {
    const failed = { ...receipt, logs: [{ ...log, data: encodeAbiParameters(parseAbiParameters('bool,bytes4'), [incremented, err]) }] } as unknown as TransactionReceipt;
    assert.equal(fundingReceiptStatus(failed, user.address, 1n), 'failed');
  }
});

test('save before send and reuse identical signed bytes after timeout, restart or already-known response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agripinaa-recovery-test-'));
  try {
    const file = join(dir, 'attempt.json');
    let signatures = 0;
    const raws: Hex[] = [];
    const options = {
      file, callsId: id, account: user.address, sender: sender.address,
      sign: async () => {
        signatures++;
        return sender.signTransaction({ chainId: 56, type: 'eip1559', nonce: 0,
          to: ALTANA_ORCHESTRATOR_BSC, value: 0n, gas: 200_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      },
      send: async (raw: Hex): Promise<Hex> => {
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).raw, raw, 'must be durable before send');
        assert.equal(statSync(file).mode & 0o777, 0o600);
        raws.push(raw);
        throw new Error('timeout');
      },
    };
    await assert.rejects(submitSavedFunding(options), /Submission uncertain/);
    const hash = await submitSavedFunding({ ...options, send: async (raw) => {
      raws.push(raw);
      throw new Error('already known');
    } });
    assert.equal(signatures, 1);
    assert.equal(raws[0], raws[1]);
    assert.equal(hash, keccak256(raws[0]!));
    await assert.rejects(submitSavedFunding({ ...options, account: sender.address }), /another submission/);
    await assert.rejects(submitSavedFunding({ ...options, send: async () => id }), /Submission uncertain/);
    await assert.rejects(submitSavedFunding({ ...options, send: async () => { throw new Error('nonce too low'); } }), /Submission uncertain/);
  } finally { rmSync(dir, { recursive: true }); }
});
