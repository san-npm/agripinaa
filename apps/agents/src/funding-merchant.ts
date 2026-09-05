import {
  ALTANA_KEYSTORE_CONTROLLER_BSC,
  ALTANA_ORCHESTRATOR_BSC,
  ALTANA_ORCHESTRATOR_VERSION_BSC,
  FUNDING_ASSETS,
  FUNDING_BOOTSTRAP_FEE_WEI,
  FUNDING_FEE_PAYER_BSC,
  FUNDING_GAS_RESERVE_WEI,
  FUNDING_MAX_REGISTRATION_FEE_WEI,
  FUNDING_QUOTE_BUFFER_BPS,
  FUNDING_REGISTRATION_COUNT,
  BPS_DENOMINATOR,
  PANCAKE_V3_QUOTER_V2_BSC,
  PANCAKE_V3_SMART_ROUTER_BSC,
  TOKENS_BSC,
  YIELD_ROUTERS_BSC,
  fundingRoute,
  isFundingAsset,
  withFundingQuoteBuffer,
  type FundingAsset,
  type FundingRoute,
  type FundingToken,
} from '@agripinaa/shared';
import { BNB, createClient as createAltanaClient, signerFromPrivateKey } from '@altananetwork/sdk';
import * as RpcResponse from 'ox/RpcResponse';
import { Route } from 'porto/server';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  hashTypedData,
  http,
  isHex,
  keccak256,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { AgentContext } from './types';

const ALTANA_RELAY_URL = 'https://relay.altana.network';
const QUOTE_TTL_MS = 30_000;

const QUOTER_ABI = parseAbi([
  'function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
]);

const WBNB_ABI = parseAbi(['function withdraw(uint256 amount)']);
const ROUTER_ABI = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);
const KEYSTORE_CONTROLLER_ABI = parseAbi([
  'function getRegistrationFeeInWei() view returns (uint256)',
  'function initialRegisterKey(bytes32 keyHash,address validator,bytes validatorData,bytes publicKey,uint40 expiry) payable',
]);

export interface FundingQuoteResponse {
  asset: FundingAsset;
  gasReserveInput: string;
  bootstrapFeeInput: string;
  totalGasInput: string;
  gasReserveWei: string;
  bootstrapFeeWei: string;
  registrationFeeWei: string;
  registrationCount: number;
  feePayer: Address;
  expiresAt: number;
}

type QuoteClient = Pick<AgentContext['publicClient'], 'readContract'>;

function exactOutputPath(route: FundingRoute): Hex {
  const tokens = [...route.tokens].reverse();
  const fees = [...route.fees].reverse();
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  tokens.forEach((symbol, index) => {
    types.push('address');
    values.push(TOKENS_BSC[symbol]!.address);
    if (index < fees.length) {
      types.push('uint24');
      values.push(fees[index]!);
    }
  });
  return encodePacked(types, values);
}

function exactInputPath(route: FundingRoute): Hex {
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  route.tokens.forEach((symbol, index) => {
    types.push('address');
    values.push(TOKENS_BSC[symbol]!.address);
    if (index < route.fees.length) {
      types.push('uint24');
      values.push(route.fees[index]!);
    }
  });
  return encodePacked(types, values);
}

async function quoteInputForNative(
  client: QuoteClient,
  asset: Exclude<FundingAsset, 'BNB'>,
  nativeAmount: bigint,
): Promise<bigint> {
  const result = await client.readContract({
    address: PANCAKE_V3_QUOTER_V2_BSC,
    abi: QUOTER_ABI,
    functionName: 'quoteExactOutput',
    args: [exactOutputPath(fundingRoute(asset, 'WBNB')), nativeAmount],
  });
  const amountIn = Array.isArray(result) ? result[0] : result;
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) {
    throw new Error(`no Pancake gas quote for ${asset}`);
  }
  return withFundingQuoteBuffer(amountIn);
}

export async function fundingQuote(
  client: QuoteClient,
  asset: FundingAsset,
  now = Date.now(),
): Promise<FundingQuoteResponse> {
  const registrationFee = await client.readContract({
    address: ALTANA_KEYSTORE_CONTROLLER_BSC,
    abi: KEYSTORE_CONTROLLER_ABI,
    functionName: 'getRegistrationFeeInWei',
  });
  if (typeof registrationFee !== 'bigint' || registrationFee < 0n) {
    throw new Error('invalid Altana registration fee');
  }
  if (registrationFee > FUNDING_MAX_REGISTRATION_FEE_WEI) {
    throw new Error('Altana registration fee exceeds the funding safety cap');
  }
  const gasReserveWei = FUNDING_GAS_RESERVE_WEI + registrationFee * FUNDING_REGISTRATION_COUNT;
  const [gasReserveInput, bootstrapFeeInput] = asset === 'BNB'
    ? [gasReserveWei, FUNDING_BOOTSTRAP_FEE_WEI]
    : await Promise.all([
        quoteInputForNative(client, asset, gasReserveWei),
        quoteInputForNative(client, asset, FUNDING_BOOTSTRAP_FEE_WEI),
      ]);
  return {
    asset,
    gasReserveInput: gasReserveInput.toString(),
    bootstrapFeeInput: bootstrapFeeInput.toString(),
    totalGasInput: (gasReserveInput + bootstrapFeeInput).toString(),
    gasReserveWei: gasReserveWei.toString(),
    bootstrapFeeWei: FUNDING_BOOTSTRAP_FEE_WEI.toString(),
    registrationFeeWei: registrationFee.toString(),
    registrationCount: Number(FUNDING_REGISTRATION_COUNT),
    feePayer: FUNDING_FEE_PAYER_BSC,
    expiresAt: now + QUOTE_TTL_MS,
  };
}

type MerchantCall = { to: Address; data?: Hex; value?: bigint };
type MerchantRequest = {
  chainId: number;
  from?: Address;
  calls: readonly MerchantCall[];
  capabilities: {
    authorizeKeys?: readonly unknown[];
    meta: { feePayer?: Address; feeToken?: Address; nonce?: bigint };
    preCall?: boolean;
    preCalls?: readonly unknown[];
    requiredFunds?: readonly unknown[];
    revokeKeys?: readonly unknown[];
  };
  key?: {
    prehash: boolean;
    publicKey: Hex;
    type: 'p256' | 'secp256k1' | 'webauthnp256';
  };
};

type MerchantRelayResult = {
  capabilities?: { feePayerDigest?: Hex };
  context?: {
    quote?: {
      ttl?: number;
      quotes?: readonly {
        chainId?: number;
        orchestrator?: Address;
        intent?: {
          combinedGas?: bigint;
          encodedFundTransfers?: readonly Hex[];
          encodedPreCalls?: readonly Hex[];
          eoa?: Address;
          executionData?: Hex;
          expiry?: bigint;
          isMultichain?: boolean;
          nonce?: bigint;
          payer?: Address;
          paymentToken?: Address;
          paymentMaxAmount?: bigint;
          paymentAmount?: bigint;
          settler?: Address;
        };
      }[];
    };
  };
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Exact Porto request envelope emitted by this browser bootstrap. */
function hasCanonicalMerchantEnvelope(request: MerchantRequest): boolean {
  const { capabilities, key } = request;
  return Boolean(
    capabilities
    && Array.isArray(capabilities.authorizeKeys)
    && capabilities.authorizeKeys.length === 0
    && capabilities.preCall === false
    && (capabilities.preCalls === undefined
      || (Array.isArray(capabilities.preCalls) && capabilities.preCalls.length === 0))
    && capabilities.requiredFunds === undefined
    && capabilities.revokeKeys === undefined
    && capabilities.meta
    && capabilities.meta.feePayer === undefined
    && capabilities.meta.nonce === undefined
    && capabilities.meta.feeToken?.toLowerCase() === ZERO_ADDRESS
    && key
    && key.type === 'webauthnp256'
    && key.prehash === false
    // A WebAuthn P-256 public key is x || y: exactly 64 bytes.
    && /^0x[0-9a-fA-F]{128}$/.test(key.publicKey)
  );
}

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

function decodeCalls(executionData: Hex): readonly MerchantCall[] | null {
  try {
    const [calls] = decodeAbiParameters(BATCH_CALLS_ABI, executionData);
    return calls;
  } catch {
    return null;
  }
}

function validRelayPreCalls(values: readonly Hex[], request: MerchantRequest): boolean {
  if (!request.from || values.length > 2) return false;
  const allowed = new Set([request.from.toLowerCase(), FUNDING_FEE_PAYER_BSC.toLowerCase()]);
  const accounts = values.map((value) => {
    try {
      return decodeAbiParameters(PRE_CALL_ABI, value)[0].eoa.toLowerCase();
    } catch {
      return null;
    }
  });
  return accounts.every((account) => account !== null && allowed.has(account))
    && new Set(accounts).size === accounts.length;
}

/** Bind sponsorship to the exact live relay quote before the fee-payer digest is signed. */
export function validFundingRelayQuote(
  request: MerchantRequest,
  result: MerchantRelayResult,
  now = Date.now(),
): boolean {
  if (!hasCanonicalMerchantEnvelope(request) || !result.capabilities?.feePayerDigest) return false;
  const quote = result.context?.quote;
  if (!quote || !quote.ttl || quote.ttl * 1_000 <= now || quote.quotes?.length !== 1) return false;
  const item = quote.quotes[0]!;
  const intent = item.intent;
  if (
    !intent
    || item.chainId !== 56
    || item.orchestrator?.toLowerCase() !== ALTANA_ORCHESTRATOR_BSC.toLowerCase()
    || typeof intent.eoa !== 'string'
    || intent.eoa?.toLowerCase() !== request.from?.toLowerCase()
    || typeof intent.payer !== 'string'
    || intent.payer?.toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()
    || typeof intent.paymentToken !== 'string'
    || intent.paymentToken?.toLowerCase() !== ZERO_ADDRESS
    || intent.isMultichain !== false
    || typeof intent.nonce !== 'bigint'
    || (intent.nonce >> 240n) === 0xc1d0n
    || typeof intent.combinedGas !== 'bigint'
    || intent.combinedGas <= 0n
    || typeof intent.expiry !== 'bigint'
    || typeof intent.executionData !== 'string'
    || !isHex(intent.executionData)
    || !Array.isArray(intent.encodedPreCalls)
    || !Array.isArray(intent.encodedFundTransfers)
    || intent.encodedFundTransfers.length !== 0
    || typeof intent.settler !== 'string'
    || typeof intent.paymentMaxAmount !== 'bigint'
    || typeof intent.paymentAmount !== 'bigint'
  ) return false;
  const decodedCalls = decodeCalls(intent.executionData);
  if (
    !decodedCalls
    || decodedCalls.length !== request.calls.length
    || decodedCalls.some((call, index) => {
      const requested = request.calls[index]!;
      return call.to.toLowerCase() !== requested.to.toLowerCase()
        || (call.value ?? 0n) !== (requested.value ?? 0n)
        || (call.data ?? '0x').toLowerCase() !== (requested.data ?? '0x').toLowerCase();
    })
  ) return false;
  if (!validRelayPreCalls(intent.encodedPreCalls, request)) return false;
  const expectedDigest = hashTypedData({
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
      calls: decodedCalls.map((call) => ({
        data: call.data ?? '0x',
        to: call.to,
        value: call.value ?? 0n,
      })),
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
  return result.capabilities.feePayerDigest.toLowerCase() === expectedDigest.toLowerCase()
    && intent.paymentMaxAmount > 0n
    && intent.paymentAmount > 0n
    && intent.paymentAmount <= intent.paymentMaxAmount
    && intent.paymentMaxAmount <= FUNDING_BOOTSTRAP_FEE_WEI;
}

/** Stable limiter key extracted only from a syntactically valid Porto request. */
export function fundingRequestAccount(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { method?: unknown; params?: unknown };
    if (parsed.method !== 'wallet_prepareCalls' || !Array.isArray(parsed.params)) return null;
    const first = parsed.params[0] as { from?: unknown } | undefined;
    return typeof first?.from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first.from)
      ? first.from.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const TOKEN_BY_ADDRESS = new Map(
  Object.values(TOKENS_BSC).map((token) => [token.address.toLowerCase(), token.symbol as FundingToken]),
);
const ALLOWED_APPROVAL_SPENDERS = new Set([
  PANCAKE_V3_SMART_ROUTER_BSC,
  '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', // Ophis VaultRelayer
  '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', // Aave v3 pool
  '0xfD5840Cd36d94D7229439859C0112a4185BC0255', // Venus vUSDT
  '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', // Pancake v3 position manager
  ...YIELD_ROUTERS_BSC.map((router) => router.address),
].map((address) => address.toLowerCase()));
const ALLOWED_TOKEN_TARGETS = new Set([
  ...Object.values(TOKENS_BSC).map((token) => token.address),
  ...YIELD_ROUTERS_BSC.flatMap((router) => [router.aUsdt, router.vUsdt]),
].map((address) => address.toLowerCase()));

/**
 * `fundingQuote` publishes ceil(exactInput * (1 + buffer)). Recovering the
 * integer upper bound below guarantees the submitted input still covers the
 * relay's fresh exact-output quote; the looser 95% drift window did not.
 */
function amountCanSatisfyQuote(amount: bigint, bufferedQuote: bigint): boolean {
  const exactInputUpperBound = bufferedQuote * BPS_DENOMINATOR
    / (BPS_DENOMINATOR + FUNDING_QUOTE_BUFFER_BPS);
  return amount >= exactInputUpperBound && amount <= bufferedQuote * 105n / 100n;
}

function amountIsSafeOverage(amount: bigint, freshMinimum: bigint): boolean {
  return amount >= freshMinimum && amount <= freshMinimum * 105n / 100n;
}

export async function validReimbursedFundingRequest(
  client: QuoteClient,
  request: MerchantRequest,
): Promise<boolean> {
  if (
    request.chainId !== 56
    || !request.from
    || request.calls.length < 9
    || request.calls.length > 20
    || !hasCanonicalMerchantEnvelope(request)
  ) {
    return false;
  }
  const calls = request.calls;
  const account = request.from.toLowerCase();
  let reimbursement: { asset: Exclude<FundingAsset, 'BNB'>; amount: bigint; index: number } | null = null;
  let reimbursementUnwrap: { index: number } | null = null;
  const accountSwaps: { amountIn: bigint; minimum: bigint; path: Hex; index: number }[] = [];
  const approvals: { token: string; spender: string; amount: bigint; index: number }[] = [];
  let reserveWithdrawal: { amount: bigint; index: number } | null = null;
  let initialRegistration: { value: bigint; index: number } | null = null;

  for (const [index, call] of calls.entries()) {
    const target = call.to.toLowerCase();
    const value = call.value ?? 0n;
    if (target === ALTANA_KEYSTORE_CONTROLLER_BSC.toLowerCase()) {
      if (initialRegistration) return false;
      try {
        const decoded = decodeFunctionData({ abi: KEYSTORE_CONTROLLER_ABI, data: call.data ?? '0x' });
        if (decoded.functionName !== 'initialRegisterKey') return false;
        const [keyHash, validator, validatorData, publicKey, expiry] = decoded.args;
        if (
          publicKey.toLowerCase() !== request.key!.publicKey.toLowerCase()
          || keyHash.toLowerCase() !== keccak256(publicKey).toLowerCase()
          || validator.toLowerCase() !== ZERO_ADDRESS
          || validatorData !== '0x'
          || expiry !== 0
          || call.data?.toLowerCase() !== encodeFunctionData({
            abi: KEYSTORE_CONTROLLER_ABI,
            functionName: 'initialRegisterKey',
            args: [keyHash, validator, validatorData, publicKey, expiry],
          }).toLowerCase()
        ) return false;
        initialRegistration = { value, index };
      } catch {
        return false;
      }
      continue;
    }
    if (target === PANCAKE_V3_SMART_ROUTER_BSC.toLowerCase()) {
      if (value !== 0n) return false;
      try {
        const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: call.data ?? '0x' });
        if (decoded.functionName === 'unwrapWETH9') {
          if (
            reimbursementUnwrap
            || decoded.args[0] !== FUNDING_BOOTSTRAP_FEE_WEI
            || decoded.args[1].toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()
          ) return false;
          reimbursementUnwrap = { index };
          continue;
        }
        if (decoded.functionName !== 'exactInput') return false;
        const params = decoded.args[0];
        if (params.amountIn <= 0n || params.amountOutMinimum <= 0n) {
          return false;
        }
        if (params.recipient.toLowerCase() === PANCAKE_V3_SMART_ROUTER_BSC.toLowerCase()) {
          if (reimbursement || params.amountOutMinimum !== FUNDING_BOOTSTRAP_FEE_WEI) return false;
          const source = (['BTCB', 'USDT', 'USDC'] as const).find((asset) =>
            params.path.toLowerCase() === exactInputPath(fundingRoute(asset, 'WBNB')).toLowerCase(),
          );
          if (!source) return false;
          reimbursement = { asset: source, amount: params.amountIn, index };
        } else if (params.recipient.toLowerCase() === account) {
          accountSwaps.push({
            amountIn: params.amountIn,
            minimum: params.amountOutMinimum,
            path: params.path,
            index,
          });
        } else return false;
      } catch {
        return false;
      }
      continue;
    }
    if (!ALLOWED_TOKEN_TARGETS.has(target) || value !== 0n) return false;
    const symbol = TOKEN_BY_ADDRESS.get(target);
    try {
      if (symbol === 'WBNB' && call.data?.slice(0, 10).toLowerCase() === '0x2e1a7d4d') {
        const decoded = decodeFunctionData({ abi: WBNB_ABI, data: call.data });
        if (decoded.functionName !== 'withdraw' || reserveWithdrawal) return false;
        reserveWithdrawal = { amount: decoded.args[0], index };
        continue;
      }
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data ?? '0x' });
      if (decoded.functionName === 'approve') {
        if (!ALLOWED_APPROVAL_SPENDERS.has(decoded.args[0].toLowerCase())) return false;
        approvals.push({
          token: target,
          spender: decoded.args[0].toLowerCase(),
          amount: decoded.args[1],
          index,
        });
        continue;
      }
      return false;
    } catch {
      return false;
    }
  }

  if (!reimbursement || !reimbursementUnwrap || !reserveWithdrawal) return false;
  // The browser emits two fixed bootstrap segments before any capital swaps:
  // approve(0), approve(exact), swap, then unwrap/withdraw. Requiring exact
  // positions prevents callers from appending gas-amplifying calls while still
  // collecting the fixed reimbursement.
  if (
    reimbursement.index !== 2
    || reimbursementUnwrap.index !== 3
    || reserveWithdrawal.index !== 7
  ) return false;
  const quote = await fundingQuote(client, reimbursement.asset);
  const quotedFee = BigInt(quote.bootstrapFeeInput);
  if (!amountCanSatisfyQuote(reimbursement.amount, quotedFee)) return false;
  const quotedReserve = BigInt(quote.gasReserveInput);
  const freshReserveWei = BigInt(quote.gasReserveWei);
  const expectedReservePath = exactInputPath(fundingRoute(reimbursement.asset, 'WBNB')).toLowerCase();
  const reserveSwap = accountSwaps.find(({ amountIn, minimum, path, index }) =>
    index === 6
    && path.toLowerCase() === expectedReservePath
    && amountCanSatisfyQuote(amountIn, quotedReserve)
    && minimum === reserveWithdrawal.amount
    && amountIsSafeOverage(minimum, freshReserveWei),
  );
  if (!reserveSwap) return false;
  const sourceToken = TOKENS_BSC[reimbursement.asset]!.address.toLowerCase();
  const router = PANCAKE_V3_SMART_ROUTER_BSC.toLowerCase();
  const approvalAt = (index: number, amount: bigint) => approvals.some((approval) =>
    approval.index === index
    && approval.token === sourceToken
    && approval.spender === router
    && approval.amount === amount,
  );
  if (
    !approvalAt(0, 0n)
    || !approvalAt(1, reimbursement.amount)
    || !approvalAt(4, 0n)
    || !approvalAt(5, reserveSwap.amountIn)
  ) return false;

  const strategySwaps = accountSwaps
    .filter((swap) => swap.index !== reserveSwap.index)
    .sort((a, b) => a.index - b.index);
  if (strategySwaps.length > 2) return false;
  const seenTargets = new Set<FundingToken>();
  let nextIndex = 8;
  for (const swap of strategySwaps) {
    if (swap.index !== nextIndex + 2) return false;
    const target = (['WBNB', 'USDT', 'USDC', 'BTCB'] as const).find((candidate) =>
      candidate !== reimbursement.asset
      && swap.path.toLowerCase()
        === exactInputPath(fundingRoute(reimbursement.asset, candidate)).toLowerCase(),
    );
    if (!target || seenTargets.has(target)) return false;
    seenTargets.add(target);
    if (!approvalAt(nextIndex, 0n) || !approvalAt(nextIndex + 1, swap.amountIn)) return false;
    nextIndex += 3;
  }

  const terminalIndex = initialRegistration ? calls.length - 1 : calls.length;
  if (initialRegistration && initialRegistration.index !== terminalIndex) return false;
  const venueApprovals = approvals.filter(({ index }) => index >= nextIndex && index < terminalIndex);
  if (venueApprovals.length < 1 || venueApprovals.length > 4) return false;
  if (venueApprovals.length !== terminalIndex - nextIndex) return false;
  const seenVenueApprovals = new Set<string>();
  for (const approval of venueApprovals) {
    if (approval.index !== nextIndex || approval.spender === router || approval.amount !== maxUint256) {
      return false;
    }
    const key = `${approval.token}:${approval.spender}`;
    if (seenVenueApprovals.has(key)) return false;
    seenVenueApprovals.add(key);
    nextIndex += 1;
  }
  if (nextIndex !== terminalIndex) return false;
  if (initialRegistration) {
    if (
      !amountIsSafeOverage(initialRegistration.value, BigInt(quote.registrationFeeWei))
      || reserveWithdrawal.amount !== FUNDING_GAS_RESERVE_WEI
        + initialRegistration.value * FUNDING_REGISTRATION_COUNT
      || initialRegistration.index <= reserveWithdrawal.index
    ) return false;
  }
  return true;
}

/** Porto uses `false` to mean user-paid fallback, so a policy miss must throw. */
export async function requireReimbursedFundingRequest(
  client: QuoteClient,
  request: MerchantRequest,
): Promise<true> {
  if (!await validReimbursedFundingRequest(client, request)) {
    throw new RpcResponse.InvalidParamsError({
      message: 'Funding merchant rejected the reimbursed bundle. Refresh the quote and retry.',
    });
  }
  return true;
}

export function createFundingMerchant(args: {
  client: QuoteClient;
  privateKey: Hex;
}) {
  const account = privateKeyToAccount(args.privateKey);
  if (account.address.toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()) {
    throw new Error('facilitator key does not match the published funding fee payer');
  }
  return Route.merchant({
    address: account.address,
    key: args.privateKey,
    relay: http(ALTANA_RELAY_URL),
    // `sponsor` is Porto's API name for choosing a fee payer. Agripinaa's
    // payer is reimbursed in native BNB inside every bundle this returns true.
    // Porto treats `false` as "prepare the same bundle without a fee payer".
    // The policy helper therefore returns true or throws; it never silently
    // shifts the atomic funding bundle back to the user.
    sponsor: (request) => requireReimbursedFundingRequest(
      args.client,
      request as MerchantRequest,
    ),
    approve: (request, result) => validFundingRelayQuote(
      request as MerchantRequest,
      result as MerchantRelayResult,
    ),
  });
}

/**
 * Registers the existing fee-payer EOA with Altana's relay. This is
 * counterfactual: it signs the future EIP-7702 setup but sends no transaction
 * and spends no BNB. The setup is required before the address can pay a
 * merchant-prepared call bundle.
 */
export async function prepareFundingFeePayer(privateKey: Hex): Promise<void> {
  const expected = privateKeyToAccount(privateKey).address;
  if (expected.toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()) {
    throw new Error('facilitator key does not match the published funding fee payer');
  }
  const wallet = await createAltanaClient({ chains: [BNB], defaultChainId: 56 }).createWallet({
    signer: signerFromPrivateKey(privateKey),
  });
  if (wallet.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Altana registered a different funding fee-payer address');
  }
}

export function parseFundingAsset(value: string | null): FundingAsset | null {
  return isFundingAsset(value) && (FUNDING_ASSETS as readonly string[]).includes(value) ? value : null;
}
