import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  ALTANA_KEYSTORE_CONTROLLER_BSC,
  ALTANA_ORCHESTRATOR_BSC,
  ALTANA_ORCHESTRATOR_VERSION_BSC,
  FUNDING_BOOTSTRAP_FEE_WEI,
  FUNDING_FEE_PAYER_BSC,
  FUNDING_GAS_RESERVE_WEI,
  FUNDING_REGISTRATION_COUNT,
  PANCAKE_V3_SMART_ROUTER_BSC,
  TOKENS_BSC,
  fundingRoute,
  withFundingQuoteBuffer,
} from '@agripinaa/shared';
import {
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  custom,
  encodeAbiParameters,
  keccak256,
  hashTypedData,
  maxUint256,
  numberToHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { Route } from 'porto/server';

import {
  fundingQuote,
  requireReimbursedFundingRequest,
  validFundingRelayQuote,
  validReimbursedFundingRequest,
} from '../src/funding-merchant';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER_ABI = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);
const WBNB_ABI = parseAbi(['function withdraw(uint256 amount)']);
const KEYSTORE_CONTROLLER_ABI = parseAbi([
  'function initialRegisterKey(bytes32 keyHash,address validator,bytes validatorData,bytes publicKey,uint40 expiry) payable',
]);
const REGISTRATION_FEE = 1_000_000_000_000n;
const ADMIN_PUBLIC_KEY = `0x${'11'.repeat(64)}` as Hex;
type TestCall = { to: Address; data?: Hex; value?: bigint };
const BATCH_CALLS_ABI = [{
  type: 'tuple[]',
  components: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
}] as const;
const PRE_CALL_ABI = [{
  type: 'tuple',
  components: [
    { name: 'eoa', type: 'address' },
    { name: 'executionData', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
}] as const;
const canonicalEnvelope = {
  capabilities: {
    authorizeKeys: [],
    meta: { feeToken: '0x0000000000000000000000000000000000000000' as Address },
    preCall: false,
    preCalls: [],
  },
  key: {
    prehash: false,
    publicKey: ADMIN_PUBLIC_KEY,
    type: 'webauthnp256' as const,
  },
};

function merchantRequest(calls: readonly TestCall[]) {
  return {
    chainId: 56,
    from: ACCOUNT,
    calls,
    ...canonicalEnvelope,
  };
}

const client = {
  async readContract(args: { functionName?: string; args?: readonly unknown[] }) {
    if (args.functionName === 'getRegistrationFeeInWei') return REGISTRATION_FEE;
    const amountOut = args.args?.[1];
    if (typeof amountOut !== 'bigint') throw new Error('missing quote amount');
    return [amountOut * 1_000n, [], [], 1n];
  },
};

function inputPath(source: 'USDT', target: 'WBNB' | 'USDC'): Hex {
  const route = fundingRoute(source, target);
  return encodePacked(
    ['address', 'uint24', 'address'],
    [TOKENS_BSC[route.tokens[0]!]!.address, route.fees[0]!, TOKENS_BSC[route.tokens[1]!]!.address],
  );
}

describe('reimbursed funding merchant', () => {
  it('pins Porto to fail closed when an explicit merchant cannot prepare the bundle', async () => {
    const require = createRequire(import.meta.url);
    const viemEntry = require.resolve('porto/viem');
    const source = await readFile(new URL('./RelayActions.js', pathToFileURL(viemEntry)), 'utf8');
    assert.match(source, /return await RelayActions\.prepareCalls\(client_, args\);/);
    assert.doesNotMatch(source, /prepareCalls\(client_, args\)\.catch/);
    assert.doesNotMatch(source, /Fall back to default client/);

    const serverEntry = require.resolve('porto/server');
    const routeSource = await readFile(new URL('./Route.js', pathToFileURL(serverEntry)), 'utf8');
    assert.match(routeSource, /const sponsor = await \(\(\) =>/);
    assert.match(routeSource, /options\.sponsor\(request\._decoded\.params\[0\]\)/);
    assert.match(routeSource, /const decoded = z\.decode\(MerchantSchema\.wallet_prepareCalls\.Response, result\)/);
    assert.match(routeSource, /options\.approve\(request\._decoded\.params\[0\], decoded\)/);
    assert.doesNotMatch(routeSource, /options\.approve\(request\._decoded\.params\[0\], result\)/);
    assert.doesNotMatch(routeSource, /const sponsor = \(\(\) =>/);

    const altanaEntry = import.meta.resolve('@altananetwork/sdk');
    const relaySource = await readFile(
      new URL('./internal/relay.js', altanaEntry),
      'utf8',
    );
    assert.match(relaySource, /effectiveCalls = opts\.merchantUrl\s*\? \[\.\.\.calls, \.\.\.prepend\]/);
    assert.match(relaySource, /opts\.merchantUrl \? \{ merchantUrl: opts\.merchantUrl \}/);
    assert.match(relaySource, /opts\.nonce !== undefined \? \{ nonce: opts\.nonce \} : \{\}/);

    const executeSource = await readFile(new URL('./execute.js', altanaEntry), 'utf8');
    assert.match(executeSource, /await opts\.onSubmitted\?\.\(callsId\)/);
    assert.match(executeSource, /export async function waitForExecution\(callsId, opts\)/);
    assert.match(executeSource, /opts\.nonce !== undefined \? \{ nonce: opts\.nonce \} : \{\}/);

    const revokeSource = await readFile(new URL('./revokeSession.js', altanaEntry), 'utf8');
    assert.match(revokeSource, /await config\.onSubmitted\?\.\(callsId\)/);
  });

  it('hard-rejects a policy miss instead of requesting user-paid fallback', async () => {
    await assert.rejects(
      requireReimbursedFundingRequest(client as never, merchantRequest([])),
      /rejected the reimbursed bundle/,
    );
  });

  it('returns an RPC error when the merchant policy rejects before relay preparation', async () => {
    let forwarded = false;
    const route = Route.merchant({
      address: FUNDING_FEE_PAYER_BSC,
      key: `0x${'01'.repeat(32)}`,
      sponsor: (request) => requireReimbursedFundingRequest(client as never, request as never),
      relay: custom({
        async request() {
          forwarded = true;
          throw new Error('must not forward');
        },
      }),
    });
    const response = await route.fetch(new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'wallet_prepareCalls',
        params: [{ calls: [], capabilities: { meta: {} }, chainId: '0x38', from: ACCOUNT }],
      }),
    }));
    const body = await response.json() as { error?: { code?: number; stack?: string } };
    assert.equal(response.status, 200);
    assert.equal(body.error?.code, -32602);
    assert.equal(body.error?.stack, '');
    assert.equal(forwarded, false);
  });

  it('awaits an asynchronous merchant refusal before forwarding to the relay', async () => {
    let forwarded: { params?: readonly unknown[] } | undefined;
    let decodedChainId: number | undefined;
    const route = Route.merchant({
      address: FUNDING_FEE_PAYER_BSC,
      key: `0x${'01'.repeat(32)}`,
      sponsor: async (request) => {
        decodedChainId = request.chainId;
        return false;
      },
      relay: custom({
        async request(args) {
          forwarded = args as { params?: readonly unknown[] };
          throw new Error('stop after observing forwarded request');
        },
      }),
    });
    const response = await route.fetch(new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        _returnType: null,
        method: 'wallet_prepareCalls',
        params: [{
          calls: [],
          capabilities: { meta: {} },
          chainId: '0x38',
          from: ACCOUNT,
        }],
      }),
    }));
    assert.ok(forwarded, await response.text());
    assert.equal(decodedChainId, 56, 'the sponsor policy must receive decoded JSON-RPC values');
    const params = forwarded.params?.[0] as { capabilities?: { meta?: { feePayer?: string } } };
    assert.equal(params.capabilities?.meta?.feePayer, undefined);
  });

  it('refuses the exact relay quote before producing a fee-payer signature', async () => {
    let approved = false;
    const route = Route.merchant({
      address: FUNDING_FEE_PAYER_BSC,
      key: `0x${'01'.repeat(32)}`,
      sponsor: true,
      approve: async () => {
        approved = true;
        return false;
      },
      relay: custom({
        async request() {
          return {
            capabilities: { feePayerDigest: `0x${'22'.repeat(32)}` },
            context: {},
            digest: `0x${'33'.repeat(32)}`,
            key: null,
            signature: `0x${'44'.repeat(65)}`,
            typedData: {
              domain: {},
              message: {},
              primaryType: 'Intent',
              types: {},
            },
          };
        },
      }),
    });
    const response = await route.fetch(new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        _returnType: null,
        method: 'wallet_prepareCalls',
        params: [{
          calls: [],
          capabilities: { meta: {} },
          chainId: '0x38',
          from: ACCOUNT,
        }],
      }),
    }));
    const body = await response.json() as { error?: { message?: string }; result?: unknown };
    assert.equal(approved, true, JSON.stringify(body));
    assert.equal(body.result, undefined);
    assert.match(JSON.stringify(body), /merchant rejected relay quote/);
  });

  it('quotes both the user-owned reserve and bootstrap reimbursement in the input asset', async () => {
    const quote = await fundingQuote(client as never, 'USDT', 1_000);
    const provision = FUNDING_GAS_RESERVE_WEI + REGISTRATION_FEE * FUNDING_REGISTRATION_COUNT;
    assert.equal(quote.gasReserveInput, withFundingQuoteBuffer(provision * 1_000n).toString());
    assert.equal(quote.bootstrapFeeInput, withFundingQuoteBuffer(FUNDING_BOOTSTRAP_FEE_WEI * 1_000n).toString());
    assert.equal(quote.feePayer, FUNDING_FEE_PAYER_BSC);
    assert.equal(quote.registrationFeeWei, REGISTRATION_FEE.toString());
    assert.equal(quote.registrationCount, Number(FUNDING_REGISTRATION_COUNT));
    assert.equal(quote.expiresAt, 31_000);
  });

  it('accepts only a bundle that reimburses the payer and acquires the published BNB reserve', async () => {
    const quote = await fundingQuote(client as never, 'USDT');
    const reserveInput = BigInt(quote.gasReserveInput);
    const reserveWei = BigInt(quote.gasReserveWei);
    const reimbursement = BigInt(quote.bootstrapFeeInput);
    const calls: TestCall[] = [
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PANCAKE_V3_SMART_ROUTER_BSC, 0n],
        }),
      },
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PANCAKE_V3_SMART_ROUTER_BSC, reimbursement],
        }),
      },
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'exactInput',
          args: [{
            path: inputPath('USDT', 'WBNB'),
            recipient: PANCAKE_V3_SMART_ROUTER_BSC,
            amountIn: reimbursement,
            amountOutMinimum: FUNDING_BOOTSTRAP_FEE_WEI,
          }],
        }),
      },
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'unwrapWETH9',
          args: [FUNDING_BOOTSTRAP_FEE_WEI, FUNDING_FEE_PAYER_BSC],
        }),
      },
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PANCAKE_V3_SMART_ROUTER_BSC, 0n],
        }),
      },
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PANCAKE_V3_SMART_ROUTER_BSC, reserveInput],
        }),
      },
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'exactInput',
          args: [{
            path: inputPath('USDT', 'WBNB'),
            recipient: ACCOUNT,
            amountIn: reserveInput,
            amountOutMinimum: reserveWei,
          }],
        }),
      },
      {
        to: TOKENS_BSC.WBNB!.address,
        data: encodeFunctionData({
          abi: WBNB_ABI,
          functionName: 'withdraw',
          args: [reserveWei],
        }),
      },
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: ['0x6807dc923806fE8Fd134338EABCA509979a7e0cB', maxUint256],
        }),
      },
    ];
    assert.equal(await validReimbursedFundingRequest(client as never, merchantRequest(calls)), true);

    const impossibleSwapMinimum = [...calls];
    impossibleSwapMinimum[2] = {
      to: PANCAKE_V3_SMART_ROUTER_BSC,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'exactInput',
        args: [{
          path: inputPath('USDT', 'WBNB'),
          recipient: PANCAKE_V3_SMART_ROUTER_BSC,
          amountIn: reimbursement,
          amountOutMinimum: maxUint256,
        }],
      }),
    };
    assert.equal(
      await validReimbursedFundingRequest(client as never, merchantRequest(impossibleSwapMinimum)),
      false,
      'the payer must not sign a reimbursement swap whose minimum is impossible',
    );

    const impossibleUnwrapMinimum = [...calls];
    impossibleUnwrapMinimum[3] = {
      to: PANCAKE_V3_SMART_ROUTER_BSC,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'unwrapWETH9',
        args: [maxUint256, FUNDING_FEE_PAYER_BSC],
      }),
    };
    assert.equal(
      await validReimbursedFundingRequest(client as never, merchantRequest(impossibleUnwrapMinimum)),
      false,
      'the payer must not sign an impossible reimbursement unwrap',
    );

    const underfundedReimbursement = reimbursement * 96n / 100n;
    const underfunded = [...calls];
    underfunded[1] = {
      to: TOKENS_BSC.USDT!.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [PANCAKE_V3_SMART_ROUTER_BSC, underfundedReimbursement],
      }),
    };
    underfunded[2] = {
      to: PANCAKE_V3_SMART_ROUTER_BSC,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'exactInput',
        args: [{
          path: inputPath('USDT', 'WBNB'),
          recipient: PANCAKE_V3_SMART_ROUTER_BSC,
          amountIn: underfundedReimbursement,
          amountOutMinimum: FUNDING_BOOTSTRAP_FEE_WEI,
        }],
      }),
    };
    assert.equal(
      await validReimbursedFundingRequest(client as never, merchantRequest(underfunded)),
      false,
      'the payer must not accept an input below the fresh exact-output requirement',
    );

    let sponsoredParams: { capabilities?: { meta?: { feePayer?: string } } } | undefined;
    let sponsorAccepted: boolean | undefined;
    const liveRoute = Route.merchant({
      address: FUNDING_FEE_PAYER_BSC,
      key: `0x${'01'.repeat(32)}`,
      sponsor: async (request) => {
        sponsorAccepted = await validReimbursedFundingRequest(client as never, request as never);
        return sponsorAccepted;
      },
      relay: custom({
        async request(args) {
          sponsoredParams = args.params?.[0] as typeof sponsoredParams;
          throw new Error('stop after observing sponsored request');
        },
      }),
    });
    const decodedRequest = merchantRequest(calls);
    await liveRoute.fetch(new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 2,
        jsonrpc: '2.0',
        method: 'wallet_prepareCalls',
        params: [{
          ...canonicalEnvelope,
          capabilities: { ...decodedRequest.capabilities, preCalls: undefined },
          calls: decodedRequest.calls.map((call) => ({
            to: call.to,
            ...(call.data ? { data: call.data } : {}),
            ...(call.value !== undefined ? { value: toHex(call.value) } : {}),
          })),
          chainId: numberToHex(56),
          from: ACCOUNT,
        }],
      }),
    }));
    assert.equal(sponsorAccepted, true, 'the decoded Porto request must match the funding policy');
    assert.equal(
      sponsoredParams?.capabilities?.meta?.feePayer?.toLowerCase(),
      FUNDING_FEE_PAYER_BSC.toLowerCase(),
      'a real encoded Porto request must pass the decoded sponsor policy',
    );

    const registration = {
      to: ALTANA_KEYSTORE_CONTROLLER_BSC,
      value: REGISTRATION_FEE,
      data: encodeFunctionData({
        abi: KEYSTORE_CONTROLLER_ABI,
        functionName: 'initialRegisterKey',
        args: [
          keccak256(ADMIN_PUBLIC_KEY),
          '0x0000000000000000000000000000000000000000',
          '0x',
          ADMIN_PUBLIC_KEY,
          0,
        ],
      }),
    } as const;
    assert.equal(await validReimbursedFundingRequest(
      client as never,
      merchantRequest([...calls, registration]),
    ), true);

    const staleRegistrationFee = REGISTRATION_FEE * 101n / 100n;
    const staleReserveWei = FUNDING_GAS_RESERVE_WEI
      + staleRegistrationFee * FUNDING_REGISTRATION_COUNT;
    const staleReserveInput = withFundingQuoteBuffer(staleReserveWei * 1_000n);
    const staleQuoteCalls = [...calls];
    staleQuoteCalls[5] = {
      to: TOKENS_BSC.USDT!.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [PANCAKE_V3_SMART_ROUTER_BSC, staleReserveInput],
      }),
    };
    staleQuoteCalls[6] = {
      to: PANCAKE_V3_SMART_ROUTER_BSC,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'exactInput',
        args: [{
          path: inputPath('USDT', 'WBNB'),
          recipient: ACCOUNT,
          amountIn: staleReserveInput,
          amountOutMinimum: staleReserveWei,
        }],
      }),
    };
    staleQuoteCalls[7] = {
      to: TOKENS_BSC.WBNB!.address,
      data: encodeFunctionData({ abi: WBNB_ABI, functionName: 'withdraw', args: [staleReserveWei] }),
    };
    assert.equal(await validReimbursedFundingRequest(
      client as never,
      merchantRequest([...staleQuoteCalls, { ...registration, value: staleRegistrationFee }]),
    ), true, 'a small safe registration-fee decrease must not invalidate a browser quote');

    assert.equal(await validReimbursedFundingRequest(
      client as never,
      merchantRequest([...calls, { ...registration, value: REGISTRATION_FEE + 1n }]),
    ), false);

    const noncanonicalRegistration = {
      ...registration,
      data: encodeFunctionData({
        abi: KEYSTORE_CONTROLLER_ABI,
        functionName: 'initialRegisterKey',
        args: [
          keccak256(`0x${'22'.repeat(65)}`),
          '0x0000000000000000000000000000000000000000',
          '0x1234',
          `0x${'22'.repeat(65)}`,
          1,
        ],
      }),
    } as const;
    assert.equal(await validReimbursedFundingRequest(
      client as never,
      merchantRequest([...calls, noncanonicalRegistration]),
    ), false);

    for (const capabilities of [
      { ...canonicalEnvelope.capabilities, authorizeKeys: [{}] },
      { ...canonicalEnvelope.capabilities, revokeKeys: [{}] },
      { ...canonicalEnvelope.capabilities, preCalls: [{}] },
      { ...canonicalEnvelope.capabilities, requiredFunds: [{}] },
      { ...canonicalEnvelope.capabilities, preCall: true },
      { ...canonicalEnvelope.capabilities, meta: { ...canonicalEnvelope.capabilities.meta, nonce: 1n } },
    ]) {
      assert.equal(await validReimbursedFundingRequest(client as never, {
        ...merchantRequest(calls),
        capabilities: capabilities as never,
      }), false);
    }

    const theft = [...calls];
    theft[3] = {
      to: PANCAKE_V3_SMART_ROUTER_BSC,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'unwrapWETH9',
        args: [FUNDING_BOOTSTRAP_FEE_WEI, '0x2222222222222222222222222222222222222222'],
      }),
    };
    assert.equal(await validReimbursedFundingRequest(client as never, merchantRequest(theft)), false);

    const extraSwapSegment = (amount: bigint, target: 'WBNB' | 'USDC' = 'WBNB') => [
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PANCAKE_V3_SMART_ROUTER_BSC, 0n],
        }),
      },
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PANCAKE_V3_SMART_ROUTER_BSC, amount],
        }),
      },
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'exactInput',
          args: [{
            path: inputPath('USDT', target),
            recipient: ACCOUNT,
            amountIn: amount,
            amountOutMinimum: 1n,
          }],
        }),
      },
    ];
    const venueApproval = calls.at(-1)!;
    const amplified = [
      ...calls.slice(0, -1),
      ...extraSwapSegment(1n),
      ...extraSwapSegment(2n),
      ...extraSwapSegment(3n),
      venueApproval,
    ];
    assert.ok(amplified.length <= 20, 'the regression must exercise shape checks, not the size cap');
    assert.equal(await validReimbursedFundingRequest(client as never, merchantRequest(amplified)), false);

    const maximalCanonical = [
      ...calls.slice(0, -1),
      ...extraSwapSegment(1n, 'WBNB'),
      ...extraSwapSegment(2n, 'USDC'),
      venueApproval,
    ];
    assert.equal(await validReimbursedFundingRequest(
      client as never,
      merchantRequest(maximalCanonical),
    ), true);
  });

  it('signs only a live relay quote for the exact atomic funding batch', async () => {
    const quote = await fundingQuote(client as never, 'USDT');
    const reimbursement = BigInt(quote.bootstrapFeeInput);
    const calls: TestCall[] = [
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PANCAKE_V3_SMART_ROUTER_BSC, 0n] }),
      },
      {
        to: TOKENS_BSC.USDT!.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PANCAKE_V3_SMART_ROUTER_BSC, reimbursement] }),
      },
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'exactInput',
          args: [{
            amountIn: reimbursement,
            amountOutMinimum: FUNDING_BOOTSTRAP_FEE_WEI,
            path: inputPath('USDT', 'WBNB'),
            recipient: PANCAKE_V3_SMART_ROUTER_BSC,
          }],
        }),
      },
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'unwrapWETH9',
          args: [FUNDING_BOOTSTRAP_FEE_WEI, FUNDING_FEE_PAYER_BSC],
        }),
      },
    ];
    const request = merchantRequest(calls);
    const relayQuote = (
      maximum: bigint,
      corruptDigest = false,
      encodedPreCalls: readonly Hex[] = [],
    ) => {
      const intent = {
        combinedGas: 100_000n,
        encodedFundTransfers: [] as readonly Hex[],
        encodedPreCalls,
        eoa: ACCOUNT,
        executionData: encodeAbiParameters(BATCH_CALLS_ABI, [calls.map((call) => ({
          data: call.data ?? '0x',
          to: call.to,
          value: call.value ?? 0n,
        }))]),
        expiry: 2_000n,
        isMultichain: false,
        nonce: 2n,
        payer: FUNDING_FEE_PAYER_BSC,
        paymentAmount: maximum,
        paymentMaxAmount: maximum,
        paymentToken: '0x0000000000000000000000000000000000000000' as Address,
        settler: '0x0000000000000000000000000000000000000000' as Address,
      };
      const feePayerDigest = hashTypedData({
        domain: {
          chainId: 56,
          name: 'Orchestrator',
          verifyingContract: ALTANA_ORCHESTRATOR_BSC,
          version: ALTANA_ORCHESTRATOR_VERSION_BSC,
        },
        primaryType: 'Intent',
        types: {
          Call: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          Intent: [
            { name: 'multichain', type: 'bool' },
            { name: 'eoa', type: 'address' },
            { name: 'calls', type: 'Call[]' },
            { name: 'nonce', type: 'uint256' },
            { name: 'payer', type: 'address' },
            { name: 'paymentToken', type: 'address' },
            { name: 'paymentMaxAmount', type: 'uint256' },
            { name: 'combinedGas', type: 'uint256' },
            { name: 'encodedPreCalls', type: 'bytes[]' },
            { name: 'encodedFundTransfers', type: 'bytes[]' },
            { name: 'settler', type: 'address' },
            { name: 'expiry', type: 'uint256' },
          ],
        },
        message: {
          multichain: false,
          eoa: intent.eoa,
          calls: calls.map((call) => ({ data: call.data ?? '0x', to: call.to, value: call.value ?? 0n })),
          nonce: intent.nonce,
          payer: intent.payer,
          paymentToken: intent.paymentToken,
          paymentMaxAmount: intent.paymentMaxAmount,
          combinedGas: intent.combinedGas,
          encodedPreCalls: intent.encodedPreCalls,
          encodedFundTransfers: intent.encodedFundTransfers,
          settler: intent.settler,
          expiry: intent.expiry,
        },
      });
      return {
        capabilities: {
          feePayerDigest: corruptDigest ? `0x${'22'.repeat(32)}` as Hex : feePayerDigest,
        },
        context: {
          quote: {
            ttl: 2_000,
            quotes: [{ chainId: 56, orchestrator: ALTANA_ORCHESTRATOR_BSC, intent }],
          },
        },
      };
    };
    assert.equal(validFundingRelayQuote(request, relayQuote(FUNDING_BOOTSTRAP_FEE_WEI), 1_000_000), true);
    const preCall = (eoa: Address) => encodeAbiParameters(PRE_CALL_ABI, [{
      eoa,
      executionData: '0x',
      nonce: 0n,
      signature: '0x',
    }]);
    assert.equal(validFundingRelayQuote(request, relayQuote(
      FUNDING_BOOTSTRAP_FEE_WEI,
      false,
      [preCall(ACCOUNT), preCall(FUNDING_FEE_PAYER_BSC)],
    ), 1_000_000), true);
    assert.equal(validFundingRelayQuote(request, relayQuote(
      FUNDING_BOOTSTRAP_FEE_WEI,
      false,
      [preCall(ACCOUNT), preCall(ACCOUNT)],
    ), 1_000_000), false);
    assert.equal(validFundingRelayQuote(request, relayQuote(
      FUNDING_BOOTSTRAP_FEE_WEI,
      false,
      [preCall('0x2222222222222222222222222222222222222222')],
    ), 1_000_000), false);
    assert.equal(validFundingRelayQuote(request, relayQuote(FUNDING_BOOTSTRAP_FEE_WEI + 1n), 1_000_000), false);
    assert.equal(validFundingRelayQuote(
      request,
      relayQuote(FUNDING_BOOTSTRAP_FEE_WEI, true),
      1_000_000,
    ), false, 'a fee-payer digest not derived from the validated intent must be refused');
    assert.equal(validFundingRelayQuote(
      { ...request, capabilities: { ...request.capabilities, preCalls: [{}] } },
      relayQuote(1n),
      1_000_000,
    ), false);
  });
});
