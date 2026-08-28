import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FUNDING_BOOTSTRAP_FEE_WEI,
  FUNDING_FEE_PAYER_BSC,
  FUNDING_GAS_RESERVE_WEI,
  FUNDING_REGISTRATION_COUNT,
  PANCAKE_V3_SMART_ROUTER_BSC,
  TOKENS_BSC,
} from '@agripinaa/shared';
import { decodeFunctionData, parseAbi, type Address } from 'viem';

import {
  buildFundingBootstrapPlan,
  fundingGasQuoteIsCurrent,
  type FundingGasQuote,
  type FundingQuoteClient,
} from '../src/lib/funding-bootstrap';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const MERCHANT = 'https://example.test/api/funding/merchant';
const ROUTER_ABI = parseAbi([
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
]);
const quoteClient: FundingQuoteClient = {
  async readContract(args) {
    // Always return substantially more than the reserve minimum used by the
    // test; production reads the live Pancake Quoter.
    return [args.args[1] * 1_000_000_000_000_000_000n, [], [], 1n];
  },
};

function tokenQuote(asset: 'USDT' | 'USDC' | 'BTCB'): FundingGasQuote {
  const registrationFeeWei = 1n;
  return {
    asset,
    gasReserveInput: 3n,
    bootstrapFeeInput: 2n,
    totalGasInput: 5n,
    gasReserveWei: FUNDING_GAS_RESERVE_WEI + registrationFeeWei * FUNDING_REGISTRATION_COUNT,
    bootstrapFeeWei: FUNDING_BOOTSTRAP_FEE_WEI,
    registrationFeeWei,
    registrationCount: Number(FUNDING_REGISTRATION_COUNT),
    feePayer: FUNDING_FEE_PAYER_BSC,
    expiresAt: Date.now() + 30_000,
  };
}

function nativeQuote(): FundingGasQuote {
  const registrationFeeWei = 1n;
  const gasReserveWei = FUNDING_GAS_RESERVE_WEI + registrationFeeWei * FUNDING_REGISTRATION_COUNT;
  return {
    asset: 'BNB',
    gasReserveInput: gasReserveWei,
    bootstrapFeeInput: FUNDING_BOOTSTRAP_FEE_WEI,
    totalGasInput: gasReserveWei + FUNDING_BOOTSTRAP_FEE_WEI,
    gasReserveWei,
    bootstrapFeeWei: FUNDING_BOOTSTRAP_FEE_WEI,
    registrationFeeWei,
    registrationCount: Number(FUNDING_REGISTRATION_COUNT),
    feePayer: FUNDING_FEE_PAYER_BSC,
    expiresAt: Date.now() + 30_000,
  };
}

describe('single-deposit funding bootstrap', () => {
  it('requires a matching quote with enough time left for confirmation', () => {
    const now = 1_000;
    const quote = { ...tokenQuote('USDT'), expiresAt: now + 5_001 };

    assert.equal(fundingGasQuoteIsCurrent(quote, 'USDT', 5_000, now), true);
    assert.equal(fundingGasQuoteIsCurrent(quote, 'USDC', 5_000, now), false);
    assert.equal(fundingGasQuoteIsCurrent({ ...quote, expiresAt: now + 5_000 }, 'USDT', 5_000, now), false);
    assert.equal(fundingGasQuoteIsCurrent(null, 'USDT', 5_000, now), false);
  });

  it('keeps BNB for gas, wraps only net capital, and prepares both grid legs', async () => {
    const gross = 2_000_000_000_000_000n;
    const plan = await buildFundingBootstrapPlan({
      account: ACCOUNT,
      agent: 'grid',
      input: 'BNB',
      grossInput: gross,
      nativeBalance: gross,
      gasQuote: nativeQuote(),
      quoteClient,
      merchantUrl: MERCHANT,
    });
    assert.equal(plan.merchantUrl, undefined);
    assert.deepEqual(plan.preCalls, []);
    assert.equal(plan.nativeReserveOutputWei, 0n);
    assert.equal(plan.strategyInput, gross - nativeQuote().totalGasInput);
    assert.equal(plan.calls[0]!.to.toLowerCase(), TOKENS_BSC.WBNB!.address.toLowerCase());
    assert.equal(plan.calls[0]!.value, plan.strategyInput);
    assert.deepEqual(plan.targets, ['WBNB', 'USDT']);
    assert.ok((plan.estimatedOutputs.WBNB ?? 0n) > 0n);
    assert.ok((plan.estimatedOutputs.USDT ?? 0n) > 0n);
    assert.ok((plan.minimumOutputs.WBNB ?? 0n) > 0n);
    assert.ok((plan.minimumOutputs.USDT ?? 0n) > 0n);
  });

  it('charges an ERC-20 bootstrap cost, acquires user-owned BNB, and keeps the rest as strategy capital', async () => {
    const plan = await buildFundingBootstrapPlan({
      account: ACCOUNT,
      agent: 'venus-guardian',
      input: 'USDT',
      grossInput: 100n,
      nativeBalance: 0n,
      gasQuote: tokenQuote('USDT'),
      quoteClient,
      merchantUrl: MERCHANT,
    });
    assert.equal(plan.merchantUrl, MERCHANT);
    assert.equal(plan.strategyInput, 95n);
    assert.equal(plan.gasReserveInput, 3n);
    assert.equal(plan.bootstrapFeeInput, 2n);
    assert.equal(plan.nativeReserveOutputWei, tokenQuote('USDT').gasReserveWei);
    assert.equal(plan.preCalls.length, 4);
    const reimbursementCall = plan.preCalls.find((call) => {
      if (call.to.toLowerCase() !== PANCAKE_V3_SMART_ROUTER_BSC.toLowerCase()) return false;
      const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: call.data! });
      return decoded.functionName === 'exactInput'
        && decoded.args[0].recipient.toLowerCase() === PANCAKE_V3_SMART_ROUTER_BSC.toLowerCase();
    });
    assert.ok(reimbursementCall);
    const reimbursement = decodeFunctionData({ abi: ROUTER_ABI, data: reimbursementCall.data! });
    assert.equal(reimbursement.functionName, 'exactInput');
    assert.equal(reimbursement.args[0].amountIn, 2n);
    assert.equal(reimbursement.args[0].amountOutMinimum, FUNDING_BOOTSTRAP_FEE_WEI);
    const unwrapCall = plan.preCalls.find((call) => {
      if (call.to.toLowerCase() !== PANCAKE_V3_SMART_ROUTER_BSC.toLowerCase()) return false;
      const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: call.data! });
      return decoded.functionName === 'unwrapWETH9';
    });
    assert.ok(unwrapCall);
    const unwrap = decodeFunctionData({ abi: ROUTER_ABI, data: unwrapCall.data! });
    assert.equal(unwrap.functionName, 'unwrapWETH9');
    assert.equal(unwrap.args[0], FUNDING_BOOTSTRAP_FEE_WEI);
    assert.equal(unwrap.args[1].toLowerCase(), FUNDING_FEE_PAYER_BSC.toLowerCase());
    assert.deepEqual(plan.targets, ['USDT']);
    assert.equal(plan.estimatedOutputs.USDT, 95n);
    assert.equal(plan.minimumOutputs.USDT, 95n);
  });

  it('does not charge or invoke the merchant when a recovered account already has gas', async () => {
    const plan = await buildFundingBootstrapPlan({
      account: ACCOUNT,
      agent: 'yield',
      input: 'USDC',
      grossInput: 100n,
      nativeBalance: tokenQuote('USDC').gasReserveWei + tokenQuote('USDC').bootstrapFeeWei,
      gasQuote: tokenQuote('USDC'),
      quoteClient,
      merchantUrl: MERCHANT,
    });
    assert.equal(plan.merchantUrl, undefined);
    assert.deepEqual(plan.preCalls, []);
    assert.equal(plan.strategyInput, 100n);
    assert.equal(plan.gasReserveInput, 0n);
    assert.equal(plan.bootstrapFeeInput, 0n);
    assert.equal(plan.calls.length, 0);
    assert.deepEqual(plan.targets, ['USDC']);
    assert.equal(plan.minimumOutputs.USDC, 100n);
  });

  it('uses the merchant when existing BNB cannot cover both the reserve and direct relay cost', async () => {
    const quote = tokenQuote('USDT');
    const plan = await buildFundingBootstrapPlan({
      account: ACCOUNT,
      agent: 'yield',
      input: 'USDT',
      grossInput: 100n,
      nativeBalance: quote.gasReserveWei,
      gasQuote: quote,
      quoteClient,
      merchantUrl: MERCHANT,
    });
    assert.equal(plan.merchantUrl, MERCHANT);
    assert.equal(plan.bootstrapFeeInput, quote.bootstrapFeeInput);
    assert.equal(plan.nativeReserveOutputWei, quote.gasReserveWei);
  });

  it('refuses deposits that would leave no strategy capital', async () => {
    await assert.rejects(
      buildFundingBootstrapPlan({
        account: ACCOUNT,
        agent: 'yield',
        input: 'USDT',
        grossInput: 5n,
        nativeBalance: 0n,
        gasQuote: tokenQuote('USDT'),
        quoteClient,
        merchantUrl: MERCHANT,
      }),
      /too small/,
    );
  });
});
