'use client';

import {
  FUNDING_ASSETS,
  FUNDING_BOOTSTRAP_FEE_WEI,
  FUNDING_FEE_PAYER_BSC,
  FUNDING_GAS_RESERVE_WEI,
  FUNDING_MAX_REGISTRATION_FEE_WEI,
  FUNDING_REGISTRATION_COUNT,
  PANCAKE_V3_QUOTER_V2_BSC,
  PANCAKE_V3_SMART_ROUTER_BSC,
  fundingRoute,
  fundingTargetsForAgent,
  isFundingAsset,
  withFundingSlippage,
  type FundingAsset,
  type FundingRoute,
  type FundingToken,
} from '@agripinaa/shared/funding';
import type { AgentSlug } from '@agripinaa/shared/agents';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import {
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

export { FUNDING_ASSETS, type FundingAsset };

export interface FundingGasQuote {
  asset: FundingAsset;
  gasReserveInput: bigint;
  bootstrapFeeInput: bigint;
  totalGasInput: bigint;
  gasReserveWei: bigint;
  bootstrapFeeWei: bigint;
  registrationFeeWei: bigint;
  registrationCount: number;
  feePayer: Address;
  expiresAt: number;
}

interface SerializedFundingGasQuote {
  asset?: unknown;
  gasReserveInput?: unknown;
  bootstrapFeeInput?: unknown;
  totalGasInput?: unknown;
  gasReserveWei?: unknown;
  bootstrapFeeWei?: unknown;
  registrationFeeWei?: unknown;
  registrationCount?: unknown;
  feePayer?: unknown;
  expiresAt?: unknown;
  error?: string;
}

export interface FundingCall {
  to: Address;
  data?: Hex;
  value?: bigint;
}

export interface FundingBootstrapPlan {
  /** Main account calls. A revert here does not roll back a signed pre-call. */
  calls: readonly FundingCall[];
  /** Fee conversion collected before the main bundle when a merchant advances BNB. */
  preCalls: readonly FundingCall[];
  input: FundingAsset;
  grossInput: bigint;
  gasReserveInput: bigint;
  bootstrapFeeInput: bigint;
  /** Exact WBNB withdrawal emitted by a successful merchant-paid main batch. */
  nativeReserveOutputWei: bigint;
  strategyInput: bigint;
  targets: readonly FundingToken[];
  estimatedOutputs: Readonly<Partial<Record<FundingToken, bigint>>>;
  minimumOutputs: Readonly<Partial<Record<FundingToken, bigint>>>;
  /** Present only when Agripinaa advances the first relay fee and is reimbursed by a pre-call. */
  merchantUrl?: string;
}

const WBNB_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 amount)',
]);

const PANCAKE_ROUTER_ABI = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);

const PANCAKE_QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
]);

function bigintField(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`Funding quote has an invalid ${name}.`);
  }
  return BigInt(value);
}

export async function fetchFundingGasQuote(asset: FundingAsset): Promise<FundingGasQuote> {
  const response = await fetch(`/api/funding/quote?asset=${encodeURIComponent(asset)}`, {
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as SerializedFundingGasQuote;
  if (!response.ok) throw new Error(body.error ?? `Gas quote failed (${response.status}).`);
  if (!isFundingAsset(body.asset) || body.asset !== asset) {
    throw new Error('Gas quote returned the wrong funding asset.');
  }
  if (
    typeof body.feePayer !== 'string'
    || body.feePayer.toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()
    || typeof body.expiresAt !== 'number'
    || !Number.isSafeInteger(body.expiresAt)
    || body.expiresAt <= Date.now()
  ) {
    throw new Error('Gas quote is invalid or expired.');
  }
  const quote: FundingGasQuote = {
    asset,
    gasReserveInput: bigintField(body.gasReserveInput, 'gas reserve'),
    bootstrapFeeInput: bigintField(body.bootstrapFeeInput, 'bootstrap cost'),
    totalGasInput: bigintField(body.totalGasInput, 'total gas allocation'),
    gasReserveWei: bigintField(body.gasReserveWei, 'native reserve'),
    bootstrapFeeWei: bigintField(body.bootstrapFeeWei, 'native bootstrap cost'),
    registrationFeeWei: bigintField(body.registrationFeeWei, 'registration fee'),
    registrationCount: typeof body.registrationCount === 'number' ? body.registrationCount : Number.NaN,
    feePayer: body.feePayer as Address,
    expiresAt: body.expiresAt,
  };
  if (
    quote.bootstrapFeeWei !== FUNDING_BOOTSTRAP_FEE_WEI
    || quote.registrationFeeWei > FUNDING_MAX_REGISTRATION_FEE_WEI
    || quote.registrationCount !== Number(FUNDING_REGISTRATION_COUNT)
    || quote.gasReserveWei !== FUNDING_GAS_RESERVE_WEI
      + quote.registrationFeeWei * FUNDING_REGISTRATION_COUNT
    || quote.totalGasInput !== quote.gasReserveInput + quote.bootstrapFeeInput
  ) {
    throw new Error('Gas quote does not match the published funding policy.');
  }
  return quote;
}

export async function fundingGasQuote(asset: FundingAsset): Promise<FundingGasQuote> {
  return fetchFundingGasQuote(asset);
}

export function fundingGasQuoteIsCurrent(
  quote: FundingGasQuote | null,
  asset: FundingAsset,
  minimumRemainingMs = 0,
  now = Date.now(),
): quote is FundingGasQuote {
  return quote?.asset === asset && quote.expiresAt > now + minimumRemainingMs;
}

function pathBytes(route: FundingRoute): Hex {
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

export type FundingQuoteClient = {
  readContract(args: {
    address: Address;
    abi: typeof PANCAKE_QUOTER_ABI;
    functionName: 'quoteExactInput';
    args: readonly [Hex, bigint];
  }): Promise<unknown>;
};

async function quoteExactInput(
  client: FundingQuoteClient,
  source: FundingToken,
  target: FundingToken,
  amountIn: bigint,
): Promise<bigint> {
  if (source === target) return amountIn;
  const result = await client.readContract({
    address: PANCAKE_V3_QUOTER_V2_BSC,
    abi: PANCAKE_QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [pathBytes(fundingRoute(source, target)), amountIn],
  });
  const amountOut = Array.isArray(result) ? result[0] : result;
  if (typeof amountOut !== 'bigint' || amountOut <= 0n) {
    throw new Error(`Pancake returned no ${target} quote for ${source}.`);
  }
  return amountOut;
}

function approveCalls(token: FundingToken, amount: bigint): FundingCall[] {
  const address = TOKENS_BSC[token]!.address;
  return [
    {
      to: address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [PANCAKE_V3_SMART_ROUTER_BSC, 0n],
      }),
    },
    {
      to: address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [PANCAKE_V3_SMART_ROUTER_BSC, amount],
      }),
    },
  ];
}

async function swapCalls(
  client: FundingQuoteClient,
  account: Address,
  source: FundingToken,
  target: FundingToken,
  amountIn: bigint,
  minimumOverride?: bigint,
  recipient: Address = account,
): Promise<{ calls: FundingCall[]; expectedOut: bigint; minimumOut: bigint }> {
  const expectedOut = await quoteExactInput(client, source, target, amountIn);
  const amountOutMinimum = minimumOverride ?? withFundingSlippage(expectedOut);
  if (amountOutMinimum <= 0n) throw new Error('Funding swap is too small after slippage protection.');
  if (expectedOut < amountOutMinimum) {
    throw new Error('The funding quote no longer covers the required BNB amount. Refresh and try again.');
  }
  return {
    expectedOut,
    minimumOut: amountOutMinimum,
    calls: [
      ...approveCalls(source, amountIn),
      {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'exactInput',
          args: [{
            path: pathBytes(fundingRoute(source, target)),
            recipient,
            amountIn,
            amountOutMinimum,
          }],
        }),
      },
    ],
  };
}

export async function buildFundingBootstrapPlan(args: {
  account: Address;
  agent: AgentSlug;
  input: FundingAsset;
  grossInput: bigint;
  nativeBalance: bigint;
  gasQuote: FundingGasQuote;
  quoteClient: FundingQuoteClient;
  merchantUrl: string;
}): Promise<FundingBootstrapPlan> {
  const { account, agent, input, grossInput, nativeBalance, gasQuote, quoteClient } = args;
  if (grossInput <= 0n) throw new Error(`No ${input} deposit was found.`);
  if (gasQuote.asset !== input || gasQuote.expiresAt <= Date.now()) {
    throw new Error('Refresh the gas quote before activating.');
  }

  const calls: FundingCall[] = [];
  const preCalls: FundingCall[] = [];
  const estimatedOutputs: Partial<Record<FundingToken, bigint>> = {};
  const minimumOutputs: Partial<Record<FundingToken, bigint>> = {};
  // Without the merchant, this account pays the funding operation itself.
  // Keep both the published post-funding reserve and one full relay budget.
  const needsErc20GasBootstrap = input !== 'BNB'
    && nativeBalance < gasQuote.gasReserveWei + gasQuote.bootstrapFeeWei;
  let source: FundingToken;
  let strategyInput: bigint;
  let gasReserveInput = 0n;
  let bootstrapFeeInput = 0n;
  let nativeReserveOutputWei = 0n;

  if (input === 'BNB') {
    if (grossInput <= gasQuote.totalGasInput) {
      throw new Error('The BNB deposit is too small to leave gas and strategy capital.');
    }
    source = 'WBNB';
    gasReserveInput = gasQuote.gasReserveInput;
    bootstrapFeeInput = gasQuote.bootstrapFeeInput;
    strategyInput = grossInput - gasQuote.totalGasInput;
    calls.push({
      to: TOKENS_BSC.WBNB!.address,
      value: strategyInput,
      data: encodeFunctionData({ abi: WBNB_ABI, functionName: 'deposit' }),
    });
  } else {
    source = input;
    const totalGasInput = needsErc20GasBootstrap ? gasQuote.totalGasInput : 0n;
    if (grossInput <= totalGasInput) {
      throw new Error(`The ${input} deposit is too small to fund gas and strategy capital.`);
    }
    strategyInput = grossInput - totalGasInput;
    if (needsErc20GasBootstrap) {
      gasReserveInput = gasQuote.gasReserveInput;
      bootstrapFeeInput = gasQuote.bootstrapFeeInput;
      nativeReserveOutputWei = gasQuote.gasReserveWei;
      const bootstrapFeeSwap = await swapCalls(
        quoteClient,
        account,
        source,
        'WBNB',
        bootstrapFeeInput,
        FUNDING_BOOTSTRAP_FEE_WEI,
        PANCAKE_V3_SMART_ROUTER_BSC,
      );
      preCalls.push(...bootstrapFeeSwap.calls, {
        to: PANCAKE_V3_SMART_ROUTER_BSC,
        data: encodeFunctionData({
          abi: PANCAKE_ROUTER_ABI,
          functionName: 'unwrapWETH9',
          args: [FUNDING_BOOTSTRAP_FEE_WEI, FUNDING_FEE_PAYER_BSC],
        }),
      });
      const reserveSwap = await swapCalls(
        quoteClient,
        account,
        source,
        'WBNB',
        gasReserveInput,
        gasQuote.gasReserveWei,
      );
      calls.push(...reserveSwap.calls, {
        to: TOKENS_BSC.WBNB!.address,
        data: encodeFunctionData({
          abi: WBNB_ABI,
          functionName: 'withdraw',
          args: [gasQuote.gasReserveWei],
        }),
      });
    }
  }

  const targets = fundingTargetsForAgent(agent, input);
  if (targets.length === 1) {
    const target = targets[0]!;
    if (target === source) {
      estimatedOutputs[target] = strategyInput;
      minimumOutputs[target] = strategyInput;
    } else {
      const swap = await swapCalls(quoteClient, account, source, target, strategyInput);
      calls.push(...swap.calls);
      estimatedOutputs[target] = swap.expectedOut;
      minimumOutputs[target] = swap.minimumOut;
    }
  } else {
    const firstInput = strategyInput / 2n;
    const secondInput = strategyInput - firstInput;
    for (const [index, target] of targets.entries()) {
      const amountIn = index === 0 ? firstInput : secondInput;
      if (target === source) {
        estimatedOutputs[target] = (estimatedOutputs[target] ?? 0n) + amountIn;
        minimumOutputs[target] = (minimumOutputs[target] ?? 0n) + amountIn;
      } else {
        const swap = await swapCalls(quoteClient, account, source, target, amountIn);
        calls.push(...swap.calls);
        estimatedOutputs[target] = (estimatedOutputs[target] ?? 0n) + swap.expectedOut;
        minimumOutputs[target] = (minimumOutputs[target] ?? 0n) + swap.minimumOut;
      }
    }
  }

  return {
    calls,
    preCalls,
    input,
    grossInput,
    gasReserveInput,
    bootstrapFeeInput,
    nativeReserveOutputWei,
    strategyInput,
    targets,
    estimatedOutputs,
    minimumOutputs,
    ...(needsErc20GasBootstrap ? { merchantUrl: args.merchantUrl } : {}),
  };
}

export function strategyCapitalFromQuote(gross: bigint, quote: FundingGasQuote, nativeReady: boolean): bigint {
  const allocation = quote.asset === 'BNB' || !nativeReady ? quote.totalGasInput : 0n;
  return gross > allocation ? gross - allocation : 0n;
}
