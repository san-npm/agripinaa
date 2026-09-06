import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  ALTANA_KEYSTORE_CONTROLLER_BSC, ALTANA_ORCHESTRATOR_BSC, FUNDING_FEE_PAYER_BSC,
  PANCAKE_V3_SMART_ROUTER_BSC, TOKENS_BSC, directFundingId, directFundingNonce,
} from '@agripinaa/shared';
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodePacked, erc20Abi,
  keccak256, maxUint256, parseAbi, parseAbiParameters, toHex, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Key } from 'porto/viem';
import { createDirectFundingRelay, signedDirectFunding } from '../src/direct-funding-relay';
import { fundingQuote } from '../src/funding-merchant';

const user = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const senderKey = `0x${'04'.repeat(32)}` as Hex;
const zero = '0x0000000000000000000000000000000000000000';
const delegation = '0xc0f16888f4198f53892c53af859f673e23f26fa3';
const publicKey = `0x${'11'.repeat(64)}` as Hex;
const quoteClient = { readContract: async (args: { functionName: string; args?: readonly unknown[] }) =>
  args.functionName === 'getRegistrationFeeInWei' ? 1_000_000_000_000n : [args.args![1] as bigint * 1000n] };

async function request() {
  const quote = await fundingQuote(quoteClient as never, 'USDT');
  const approve = (amount: bigint) => ({ to: TOKENS_BSC.USDT!.address, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PANCAKE_V3_SMART_ROUTER_BSC, amount] }) });
  const swap = (amount: bigint, minimum: bigint, recipient: Hex) => ({ to: PANCAKE_V3_SMART_ROUTER_BSC, value: 0n,
    data: encodeFunctionData({ abi: parseAbi(['function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)']), functionName: 'exactInput',
      args: [{ path: encodePacked(['address', 'uint24', 'address'], [TOKENS_BSC.USDT!.address, 100, TOKENS_BSC.WBNB!.address]), recipient, amountIn: amount, amountOutMinimum: minimum }] }) });
  const fee = BigInt(quote.bootstrapFeeInput);
  const reserve = BigInt(quote.gasReserveInput);
  const calls = [approve(0n), approve(fee), swap(fee, BigInt(quote.bootstrapFeeWei), PANCAKE_V3_SMART_ROUTER_BSC), {
    to: PANCAKE_V3_SMART_ROUTER_BSC, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function unwrapWETH9(uint256,address) payable']), functionName: 'unwrapWETH9', args: [BigInt(quote.bootstrapFeeWei), FUNDING_FEE_PAYER_BSC] }),
  }, approve(0n), approve(reserve), swap(reserve, BigInt(quote.gasReserveWei), user.address), {
    to: TOKENS_BSC.WBNB!.address, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function withdraw(uint256)']), functionName: 'withdraw', args: [BigInt(quote.gasReserveWei)] }),
  }, { to: TOKENS_BSC.USDT!.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: ['0x6807dc923806fE8Fd134338EABCA509979a7e0cB', maxUint256] }) }, {
    to: ALTANA_KEYSTORE_CONTROLLER_BSC, value: BigInt(quote.registrationFeeWei), data: encodeFunctionData({ abi: parseAbi(['function initialRegisterKey(bytes32,address,bytes,bytes,uint40) payable']), functionName: 'initialRegisterKey', args: [keccak256(publicKey), zero, '0x', publicKey, 0] }),
  }];
  const nonce = directFundingNonce(`0x${'12'.repeat(16)}`);
  const intent = { eoa: user.address, executionData: encodeAbiParameters(parseAbiParameters('(address to,uint256 value,bytes data)[]'), [calls]),
    nonce: toHex(nonce), payer: FUNDING_FEE_PAYER_BSC, paymentToken: zero, paymentMaxAmount: toHex(200_000_000_000_000n), paymentAmount: toHex(150_000_000_000_000n),
    combinedGas: toHex(1_500_000n), encodedPreCalls: [], encodedFundTransfers: [], settler: zero, expiry: '0x0', isMultichain: false,
    funder: zero, funderSignature: '0x', settlerContext: '0x', paymentRecipient: zero, signature: '0x', paymentSignature: '0x', supportedAccountImplementation: '0x4b5d20cd8a3927b500540d9bccddc27385c9fa79' };
  return { context: { quote: { quotes: [{ chainId: '0x38', authorizationAddress: delegation, additionalAuthorization: null, orchestrator: ALTANA_ORCHESTRATOR_BSC, txGas: toHex(2_000_000n), intent }] } },
    signature: '0x1234', capabilities: { feeSignature: `0x${'22'.repeat(65)}` }, key: { prehash: false, publicKey, type: 'webauthnp256' } };
}

test('direct funding binds identity, nonce deadline, passkey and deployment before submission', async () => {
  const body = await request();
  const parsed = signedDirectFunding(body);
  assert.equal(parsed.id, directFundingId(user.address, parsed.recovery.intent.nonce));
  const keyHash = Key.hash({ type: 'webauthn-p256', publicKey });
  assert.equal(parsed.recovery.intent.signature, `${body.signature}${keyHash.slice(2)}00`, 'the sender must add the contract key envelope to the raw RPC signature');
  assert.equal(parsed.recovery.intent.paymentSignature, body.capabilities.feeSignature, 'native payer signatures must stay unwrapped');
  assert.throws(() => signedDirectFunding(body, Date.now() + 301_000), /expired/);
  assert.throws(() => signedDirectFunding(body, Date.now() - 100_000), /expired/);
  assert.throws(() => signedDirectFunding({ ...body, key: { ...body.key, publicKey: '0x11' } }), /passkey/);
  assert.throws(() => signedDirectFunding({ ...body, signature: '0x' }), /Unsafe/);
  assert.throws(() => signedDirectFunding({ ...body, signature: '0x123' }), /Unsafe/);
  const quote = body.context.quote.quotes[0]!;
  for (const patch of [{ chainId: '0x1' }, { orchestrator: zero }, { authorizationAddress: zero }, { txGas: toHex(3_000_000n) }]) {
    assert.throws(() => signedDirectFunding({ ...body, context: { quote: { quotes: [{ ...quote, ...patch }] } } }));
  }
});

test('direct funding journals once, survives a lost response/restart, and confirms only matching on-chain events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agripinaa-direct-test-'));
  try {
    const journal = join(dir, 'funding.json');
    let sends = 0;
    let simulations = 0;
    let receipt: unknown = null;
    let block = 5n;
    const client = { ...quoteClient, getChainId: async () => 56,
      getCode: async ({ address }: { address: string }) => address.toLowerCase() === FUNDING_FEE_PAYER_BSC.toLowerCase() ? `0xef0100${delegation.slice(2)}` : undefined,
      getTransactionCount: async () => 0, getGasPrice: async () => 50_000_000n, getBalance: async () => 10n ** 18n,
      call: async (tx: { stateOverride?: unknown; gas: bigint }) => { assert.equal(tx.stateOverride, undefined); assert.equal(tx.gas, 2_000_000n); simulations++; return { data: `0x${'00'.repeat(32)}` }; },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        sends++; assert.equal(JSON.parse(readFileSync(journal, 'utf8')).raw, serializedTransaction);
        throw new Error('timeout after RPC accepted the raw transaction');
      },
      getTransactionReceipt: async () => {
        if (!receipt) throw Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' });
        return receipt;
      }, getBlockNumber: async () => block,
    };
    const authorization = await user.signAuthorization({ chainId: 56, contractAddress: delegation, nonce: 0 });
    const opts = { client: client as never, journal, account: user.address, privateKey: senderKey,
      relayRead: async () => ({ authorization: { ...authorization, chainId: '0x38', nonce: '0x0', yParity: toHex(authorization.yParity!) } }) };
    const disabled = createDirectFundingRelay({ client: client as never, journal });
    assert.deepEqual(await disabled({ method: 'agripinaa_getFundingMode', params: [user.address] }), { enabled: false });
    await assert.rejects(disabled({ method: 'wallet_sendPreparedCalls', params: [{}] }), /not enabled/);
    const relay = createDirectFundingRelay(opts);
    const body = await request();
    const { id, recovery } = signedDirectFunding(body);
    const status = (rpc = relay) => rpc({ method: 'wallet_getCallsStatus', params: [id] }) as Promise<{ status: number; receipts: unknown[] }>;
    assert.equal((await status()).status, 100, 'a lost request stays pending until its signed deadline');
    assert.deepEqual(await relay({ method: 'wallet_sendPreparedCalls', params: [body] }), { id });
    const restarted = createDirectFundingRelay(opts);
    assert.deepEqual(await restarted({ method: 'wallet_sendPreparedCalls', params: [body] }), { id });
    assert.equal(sends, 1); assert.equal(simulations, 1); assert.equal((await status(restarted)).status, 100);
    const saved = JSON.parse(readFileSync(journal, 'utf8'));
    const log = { address: ALTANA_ORCHESTRATOR_BSC,
      blockHash: `0x${'44'.repeat(32)}`, blockNumber: 5n, blockTimestamp: 1_800_000_000n,
      transactionHash: saved.hash, transactionIndex: 0, logIndex: 0, removed: false,
      topics: encodeEventTopics({ abi: parseAbi(['event IntentExecuted(address indexed eoa,uint256 indexed nonce,bool incremented,bytes4 err)']), eventName: 'IntentExecuted', args: { eoa: user.address, nonce: recovery.intent.nonce } }),
      data: encodeAbiParameters(parseAbiParameters('bool,bytes4'), [true, '0x00000000']) };
    receipt = { transactionHash: saved.hash, blockHash: `0x${'44'.repeat(32)}`, blockNumber: 5n, gasUsed: 900_000n, status: 'success', logs: [log] };
    assert.equal((await status()).status, 100, 'wait for three confirmations');
    block = 7n;
    const confirmed = await status();
    assert.equal(confirmed.status, 201);
    const wire = JSON.parse(JSON.stringify(confirmed));
    assert.deepEqual(wire.receipts[0].logs, [{ address: log.address, data: log.data, topics: log.topics }],
      'status returns only Porto log fields; real viem metadata contains non-JSON bigint values');
    receipt = { ...receipt as object, logs: [] };
    assert.equal((await status()).status, 100, 'EVM success without the funding event is not confirmation');
    receipt = { ...receipt as object, logs: [log], status: 'reverted' };
    assert.equal((await status()).status, 500);
    const expiredId = directFundingId(user.address, directFundingNonce(`0x${'88'.repeat(16)}`, Date.now() - 301_000));
    assert.equal((await relay({ method: 'wallet_getCallsStatus', params: [expiredId] }) as { status: number }).status, 300);
    writeFileSync(`${journal}.lock`, 'test');
    assert.equal((await relay({ method: 'wallet_getCallsStatus', params: [expiredId] }) as { status: number }).status, 100, 'an in-flight or crashed validation cannot be classified as failed');
  } finally { rmSync(dir, { recursive: true }); }
});
