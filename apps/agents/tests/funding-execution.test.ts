import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createHeadlessPasskey } from '@altananetwork/sdk';
import { ALTANA_ORCHESTRATOR_BSC, FUNDING_FEE_PAYER_BSC, directFundingId } from '@agripinaa/shared/funding';
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Key } from 'porto/viem';
import { signedDirectFunding } from '../src/direct-funding-relay';

// Next compiles these client modules as ESM; the web package's Node test default is CJS.
// Execute the real sources as ESM so the import-only SDK is tested without changing the app package type.
function clientModule(name: string): string {
  const source = readFileSync(new URL(`../../web/src/lib/${name}.ts`, import.meta.url), 'utf8');
  const esm = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolved = esm.replace(/from ['"]([^'"]+)['"]/g, (_all, path: string) =>
    `from '${path.startsWith('./') ? clientModule(path.slice(2)) : import.meta.resolve(path)}'`);
  return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
}
const { executeFunding } = await import(clientModule('funding-execution'));
const { readRelayCallStatus } = await import(clientModule('session-relay-recovery'));

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
  return value;
}

test('actual SDK signs a passkey funding request, checkpoints before send, and polls only the direct sender', async (t) => {
  const signer = createHeadlessPasskey();
  const quoteSigner = privateKeyToAccount(`0x${'09'.repeat(32)}`);
  const account = '0x1111111111111111111111111111111111111111';
  const zero = '0x0000000000000000000000000000000000000000';
  const order: string[] = [];
  let checkpoint: Hex | undefined;
  let preparedId: Hex | undefined;
  let sends = 0;
  let failSend = false;
  let failPrepare = false;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://app.test' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input).startsWith('/') ? `https://app.test${input}` : input, init);
    const rpc = await request.json();
    let result: unknown;
    if (rpc.method === 'agripinaa_getFundingMode') result = { enabled: true };
    else if (rpc.method === 'eth_call') {
      assert.equal(rpc.params[0].data.slice(0, 10), '0x' + keccak256(toHex('getKeys(address)')).slice(2, 10));
      result = encodeAbiParameters(parseAbiParameters('bytes32[]'), [[]]);
    } else if (rpc.method === 'wallet_getCapabilities') {
      assert.equal(request.url, 'https://app.test/api/funding/relay');
      assert.deepEqual(rpc.params, [[56]]);
      result = { '0x38': { contracts: { accountImplementation: { address: zero }, accountProxy: { address: zero }, legacyAccountImplementations: [], legacyOrchestrators: [], orchestrator: { address: ALTANA_ORCHESTRATOR_BSC }, simulator: { address: zero } }, fees: { quoteConfig: { rateTtl: 30, ttl: 30 }, recipient: zero, tokens: [] } } };
    } else if (rpc.method === 'health') {
      assert.equal(request.url, 'https://app.test/api/funding/relay');
      result = { quoteSigner: quoteSigner.address.toLowerCase(), status: 'healthy', version: 'test' };
    } else if (rpc.method === 'wallet_prepareCalls') {
      if (failPrepare) return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'preparation unavailable' } });
      assert.equal(request.url, 'https://merchant.test/');
      const prepared = rpc.params[0];
      assert.equal(prepared.key.publicKey, signer.publicKey);
      const last = prepared.calls.at(-1);
      assert.equal(BigInt(last.value), 1020n, 'SDK must use the provisioned fee, not read a second oracle quote');
      assert.equal(decodeFunctionData({ abi: parseAbi(['function initialRegisterKey(bytes32,address,bytes,bytes,uint40) payable']), data: last.data }).functionName, 'initialRegisterKey');
      preparedId = directFundingId(account, BigInt(prepared.capabilities.meta.nonce));
      const unsigned = { capabilities: {}, context: { quote: { quotes: [{ chainId: '0x38',
        authorizationAddress: '0xc0f16888f4198f53892c53af859f673e23f26fa3', additionalAuthorization: null, orchestrator: ALTANA_ORCHESTRATOR_BSC,
        extraPayment: '0x0', ethPrice: '0x1', paymentTokenDecimals: 18, feeTokenDeficit: '0x0', txGas: toHex(2_000_000n), nativeFeeEstimate: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' },
        intent: { eoa: account, executionData: encodeAbiParameters(parseAbiParameters('(address to,uint256 value,bytes data)[]'), [prepared.calls]), nonce: prepared.capabilities.meta.nonce,
          payer: FUNDING_FEE_PAYER_BSC, paymentToken: zero, paymentAmount: toHex(100_000_000_000_000n), paymentMaxAmount: toHex(200_000_000_000_000n), combinedGas: toHex(1_500_000n), encodedPreCalls: [], encodedFundTransfers: [], settler: zero, expiry: '0x0', isMultichain: false, funder: zero, funderSignature: '0x', settlerContext: '0x', paymentRecipient: zero, signature: '0x', paymentSignature: '0x', supportedAccountImplementation: '0x4b5d20cd8a3927b500540d9bccddc27385c9fa79' },
      }] } }, digest: `0x${'22'.repeat(32)}`, key: prepared.key, typedData: { domain: {}, message: {}, primaryType: 'Intent', types: {} } };
      result = { ...unsigned, capabilities: { feeSignature: `0x${'33'.repeat(65)}` }, signature: await quoteSigner.sign({ hash: keccak256(toHex(JSON.stringify(sorted(unsigned)))) }) };
    } else if (rpc.method === 'wallet_sendPreparedCalls') {
      assert.equal(request.url, 'https://app.test/api/funding/relay');
      assert.equal(checkpoint, preparedId, 'checkpoint must exist before the signed payload leaves');
      const funding = signedDirectFunding(rpc.params[0]);
      assert.equal(funding.id, preparedId, 'real Porto wire format must parse at the alternate sender');
      const keyHash = Key.hash({ type: 'webauthn-p256', publicKey: signer.publicKey });
      assert.equal(funding.recovery.intent.signature, `${rpc.params[0].signature}${keyHash.slice(2)}00`, 'actual SDK signatures need the relay-added key hash and prehash flag');
      assert.ok(rpc.params[0].signature.length > 132, 'a real headless WebAuthn signature was produced');
      order.push('send'); sends++;
      if (failSend) return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'lost response' } });
      result = { id: preparedId };
    } else if (rpc.method === 'wallet_getCallsStatus') {
      assert.equal(request.url, 'https://app.test/api/funding/relay');
      result = { id: rpc.params[0], status: 201, receipts: [{ blockHash: `0x${'44'.repeat(32)}`, blockNumber: '0x5', chainId: '0x38', gasUsed: '0x1', status: '0x1', transactionHash: `0x${'55'.repeat(32)}`, logs: [] }] };
    } else throw new Error(`Unexpected RPC ${rpc.method}`);
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  });
  const options = { wallet: { address: account } as never, signer, chainId: 56, merchantUrl: 'https://merchant.test/', registrationFee: 1020n,
    calls: [{ to: zero, data: '0x' }] as never, onSubmitted: (id: Hex) => { checkpoint = id; order.push('checkpoint'); } };
  const result = await executeFunding(options);
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(order, ['checkpoint', 'send']);
  assert.equal((await readRelayCallStatus({ callsId: checkpoint! })).status, 'confirmed');
  failSend = true;
  await assert.rejects(executeFunding(options), (error: Error) => {
    assert.match(error.message, /Check funding status/);
    assert.doesNotMatch(error.message, /Request body|feeSignature|wallet_sendPreparedCalls|0x/);
    return true;
  });
  assert.equal(sends, 2, 'a selected direct send must not fall back or resubmit automatically');
  assert.ok(checkpoint, 'the failed response must leave a checkable id');
  failPrepare = true;
  await assert.rejects(executeFunding(options), /stopped before submission/);
  assert.equal(sends, 2, 'preparation failure must not send or clear the existing checkpoint');
});

test('funding configuration errors stop before signing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(executeFunding({ wallet: { address: '0x1111111111111111111111111111111111111111' } as never,
    signer: {} as never, chainId: 56, merchantUrl: 'https://merchant.test', calls: [] }), /Nothing was signed/);
});
