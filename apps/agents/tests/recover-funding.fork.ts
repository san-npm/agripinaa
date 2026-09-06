/// <reference lib="dom" />
/** Opt-in simulation test. Requires a fresh loopback Anvil BSC fork; never broadcasts. */
import assert from 'node:assert/strict';
import {
  ALTANA_KEYSTORE_CONTROLLER_BSC, ALTANA_ORCHESTRATOR_BSC, ALTANA_ORCHESTRATOR_VERSION_BSC,
  FUNDING_BOOTSTRAP_FEE_WEI, TOKENS_BSC,
} from '@agripinaa/shared';
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, hashTypedData,
  http, keccak256, maxUint256, parseAbi, parseAbiParameters, parseTransaction, toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { fundingQuote } from '../src/funding-merchant';
import { parseFundingRecovery, prepareFundingRecovery } from '../src/recover-funding';
import { buildFundingBootstrapPlan, type FundingGasQuote } from '../../web/src/lib/funding-bootstrap';

const url = new URL(process.env.FUNDING_RECOVERY_RPC ?? 'http://127.0.0.1:18556');
assert.equal(url.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'fork test must never use a public RPC');
const client = createPublicClient({ chain: bsc, transport: http(url.href, { timeout: 30_000, retryCount: 0 }) });
async function local(method: string, params: unknown[] = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = await response.json() as { result?: unknown; error?: unknown };
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}
assert.match(String(await local('web3_clientVersion')), /anvil/i);
assert.equal(await client.getChainId(), 56);
const snapshot = await local('evm_snapshot');
try {
  const user = privateKeyToAccount(`0x${'02'.repeat(32)}`);
  const payer = privateKeyToAccount(`0x${'03'.repeat(32)}`);
  const sender = privateKeyToAccount(`0x${'04'.repeat(32)}`);
  const delegation = '0xc0f16888f4198f53892c53af859f673e23f26fa3';
  const zero = '0x0000000000000000000000000000000000000000';
  const gross = 100n * 10n ** 18n;
  for (const account of [user, payer, sender]) {
    await local('anvil_setNonce', [account.address, '0x0']);
    await local('anvil_setCode', [account.address, '0x']);
    await local('anvil_setBalance', [account.address, account === user ? '0x0' : toHex(10n ** 18n)]);
  }
  // BEP20 USDT balance mapping slot 1. These fixtures exist only in the disposable fork.
  const slot = keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [user.address, 1n]));
  await local('anvil_setStorageAt', [TOKENS_BSC.USDT!.address, slot, toHex(gross, { size: 32 })]);
  assert.equal(await client.readContract({ address: TOKENS_BSC.USDT!.address, abi: erc20Abi, functionName: 'balanceOf', args: [user.address] }), gross);
  const rawQuote = await fundingQuote(client, 'USDT');
  const gasQuote = { ...rawQuote } as unknown as FundingGasQuote;
  for (const name of ['gasReserveInput', 'bootstrapFeeInput', 'totalGasInput', 'gasReserveWei', 'bootstrapFeeWei', 'registrationFeeWei'] as const) {
    gasQuote[name] = BigInt(rawQuote[name]);
  }
  const plan = await buildFundingBootstrapPlan({ account: user.address, agent: 'yield-b', input: 'USDT', grossInput: gross, nativeBalance: 0n, gasQuote, quoteClient: client, merchantUrl: 'http://localhost' });
  const publicKey = `0x${user.publicKey.slice(4)}` as Hex;
  const calls = [...plan.calls, {
    to: TOKENS_BSC.USDT!.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: ['0x6807dc923806fE8Fd134338EABCA509979a7e0cB', maxUint256] }),
  }, {
    to: ALTANA_KEYSTORE_CONTROLLER_BSC, value: gasQuote.registrationFeeWei,
    data: encodeFunctionData({ abi: parseAbi(['function initialRegisterKey(bytes32,address,bytes,bytes,uint40) payable']), functionName: 'initialRegisterKey', args: [keccak256(publicKey), zero, '0x', publicKey, 0] }),
  }].map((call) => ({ to: call.to, data: call.data ?? '0x', value: call.value ?? 0n }));
  const intent: ReturnType<typeof parseFundingRecovery>['intent'] = {
    eoa: user.address, executionData: encodeAbiParameters(parseAbiParameters('(address to,uint256 value,bytes data)[]'), [calls]),
    nonce: 0n, payer: payer.address, paymentToken: zero, paymentMaxAmount: FUNDING_BOOTSTRAP_FEE_WEI,
    combinedGas: 1_500_000n, encodedPreCalls: [], encodedFundTransfers: [], settler: zero, expiry: 0n,
    isMultichain: false, funder: zero, funderSignature: '0x', settlerContext: '0x',
    paymentAmount: FUNDING_BOOTSTRAP_FEE_WEI, paymentRecipient: zero, signature: '0x', paymentSignature: '0x',
    supportedAccountImplementation: '0x4b5d20cd8a3927b500540d9bccddc27385c9fa79',
  };
  const digest = hashTypedData({
    domain: { chainId: 56, name: 'Orchestrator', verifyingContract: ALTANA_ORCHESTRATOR_BSC, version: ALTANA_ORCHESTRATOR_VERSION_BSC },
    primaryType: 'Intent', types: {
      Call: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
      Intent: [ ['multichain', 'bool'], ['eoa', 'address'], ['calls', 'Call[]'], ['nonce', 'uint256'], ['payer', 'address'], ['paymentToken', 'address'], ['paymentMaxAmount', 'uint256'], ['combinedGas', 'uint256'], ['encodedPreCalls', 'bytes[]'], ['encodedFundTransfers', 'bytes[]'], ['settler', 'address'], ['expiry', 'uint256'] ].map(([name, type]) => ({ name: name!, type: type! })),
    }, message: { ...intent, multichain: false, calls },
  });
  // Test-owned EOAs replace the real user's passkey and production payer. No production keys/signatures.
  const signedIntent = { ...intent, signature: await user.sign({ hash: digest }), paymentSignature: await payer.sign({ hash: digest }) };
  const auth = async (account: typeof user) => {
    const authorization = await account.signAuthorization({ contractAddress: delegation, chainId: 56, nonce: 0 });
    return { ...authorization, chainId: '0x38', nonce: '0x0', yParity: toHex(authorization.yParity!) };
  };
  // Anvil's EIP-1559 gas-price suggestion defaults to 1 gwei, unlike this BSC deployment.
  const executionClient = { ...client, getGasPrice: async () => 50_000_000n };
  const options = { client: executionClient, sender: sender.address, recovery: { intent: signedIntent, gas: 2_000_000n, additionalAuthorization: await auth(payer) }, userAuthorization: await auth(user) };
  await assert.rejects(prepareFundingRecovery({ ...options, client: { ...client, getGasPrice: async () => 1_000_000_000n } }), /fee ceiling/);
  const transaction = await prepareFundingRecovery(options);
  const raw = await sender.signTransaction(transaction);
  const parsed = parseTransaction(raw);
  assert.equal(parsed.type, 'eip7702');
  assert.equal(parsed.authorizationList?.length, 2);
  assert.equal(parsed.chainId, 56);
  assert.equal(parsed.nonce, 0);
  assert.equal(await client.getTransactionCount({ address: sender.address }), 0, 'no transaction was broadcast');
  await assert.rejects(prepareFundingRecovery({ ...options, recovery: { ...options.recovery, intent: { ...signedIntent, signature: signedIntent.paymentSignature } } }), /simulation rejected/);
  await assert.rejects(prepareFundingRecovery({ ...options, recovery: { ...options.recovery, intent: { ...signedIntent, paymentSignature: signedIntent.signature } } }), /simulation rejected/);
  await local('anvil_setCode', [payer.address, `0xef0100${delegation.slice(2)}`]);
  const existingPayer = await prepareFundingRecovery({ ...options, recovery: { ...options.recovery, additionalAuthorization: null } });
  assert.equal(existingPayer.authorizationList.length, 1, 'an already delegated payer must not be reinitialized');
  await local('anvil_setCode', [user.address, `0xef0100${delegation.slice(2)}`]);
  await assert.rejects(prepareFundingRecovery(options), /untouched/);
  console.log({ result: 'full type-4 funding simulation passed; invalid user/payer signatures rejected', calls: calls.length, gas: String(transaction.gas), maximumGasCostWei: String(transaction.gas * transaction.maxFeePerGas), broadcasts: 0 });
} finally {
  assert.equal(await local('evm_revert', [snapshot]), true);
}
