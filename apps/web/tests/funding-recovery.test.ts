import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALTANA_ORCHESTRATOR_BSC,
  FUNDING_GAS_RESERVE_WEI,
} from '@agripinaa/shared/funding';
import {
  OPHIS_VAULT_RELAYER_BSC,
  PANCAKE_V3_POSITION_MANAGER,
  type ManagedApproval,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import {
  encodeAbiParameters,
  encodeEventTopics,
  maxUint256,
  parseAbiItem,
  type Address,
} from 'viem';

import {
  fundingRecoveryHash,
  recoverableStrategyFundingProblem,
  receiptProvesStrategyFundingRecovery,
} from '../src/lib/funding-recovery';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const EVENT = parseAbiItem('event Approval(address indexed owner,address indexed spender,uint256 value)');
const APPROVALS = [
  { token: 'WBNB', spender: OPHIS_VAULT_RELAYER_BSC },
  { token: 'USDT', spender: OPHIS_VAULT_RELAYER_BSC },
  { token: 'WBNB', spender: PANCAKE_V3_POSITION_MANAGER },
  { token: 'USDT', spender: PANCAKE_V3_POSITION_MANAGER },
] as const satisfies readonly ManagedApproval[];

function approval(
  token: 'WBNB' | 'USDT',
  spender: Address,
  owner = ACCOUNT,
  value = maxUint256,
) {
  return {
    address: TOKENS_BSC[token]!.address,
    topics: encodeEventTopics({
      abi: [EVENT],
      eventName: 'Approval',
      args: { owner, spender },
    }) as readonly `0x${string}`[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

function receipt(logs = APPROVALS.map(({ token, spender }) => approval(token, spender))) {
  return {
    status: 'success' as const,
    to: ALTANA_ORCHESTRATOR_BSC,
    logs,
  };
}

describe('manual funding recovery proof', () => {
  it('accepts the complete strategy-specific approval witness', () => {
    assert.equal(
      receiptProvesStrategyFundingRecovery(receipt(), ACCOUNT, APPROVALS),
      true,
    );
  });

  it('rejects a copied transaction from another passkey account', () => {
    const logs = APPROVALS.map(({ token, spender }) => approval(token, spender, OTHER));
    assert.equal(receiptProvesStrategyFundingRecovery(receipt(logs), ACCOUNT, APPROVALS), false);
  });

  it('rejects missing, non-max, reverted, and non-orchestrator witnesses', () => {
    assert.equal(receiptProvesStrategyFundingRecovery(receipt(receipt().logs.slice(1)), ACCOUNT, APPROVALS), false);
    assert.equal(
      receiptProvesStrategyFundingRecovery(
        receipt(APPROVALS.map(({ token, spender }, index) => approval(token, spender, ACCOUNT, index === 0 ? 1n : maxUint256))),
        ACCOUNT,
        APPROVALS,
      ),
      false,
    );
    assert.equal(receiptProvesStrategyFundingRecovery({ ...receipt(), status: 'reverted' }, ACCOUNT, APPROVALS), false);
    assert.equal(receiptProvesStrategyFundingRecovery({ ...receipt(), to: OTHER }, ACCOUNT, APPROVALS), false);
  });

  it('does not let a broader strategy transaction impersonate a narrower one', () => {
    assert.equal(
      receiptProvesStrategyFundingRecovery(receipt(), ACCOUNT, APPROVALS.slice(0, 2)),
      false,
    );
  });

  it('accepts only a canonical 32-byte transaction hash', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    assert.equal(fundingRecoveryHash(` ${hash} `), hash);
    assert.equal(fundingRecoveryHash('0x1234'), null);
    assert.equal(fundingRecoveryHash(`0x${'zz'.repeat(32)}`), null);
  });
});

describe('passkey-first funding recovery', () => {
  const funded = {
    agentName: 'Agripinaa Ranger',
    requiredAssets: ['USDT', 'WBNB'],
    inventory: { USDT: 1n, WBNB: 1n },
    allowances: [maxUint256, maxUint256],
    nativeBalance: FUNDING_GAS_RESERVE_WEI + 1n,
    registrationFee: 1n,
    hasLiveSession: false,
  };

  it('uses current funded state without requiring a transaction hash', () => {
    assert.equal(recoverableStrategyFundingProblem(funded), null);
  });

  it('restores a live session even after its inventory is deployed', () => {
    assert.equal(recoverableStrategyFundingProblem({
      ...funded,
      inventory: {},
      allowances: [],
      hasLiveSession: true,
    }), null);
  });

  it('fails closed on incomplete funding state', () => {
    assert.match(recoverableStrategyFundingProblem({
      ...funded,
      inventory: { USDT: 1n },
    }) ?? '', /missing WBNB/);
    assert.match(recoverableStrategyFundingProblem({
      ...funded,
      allowances: [maxUint256, 0n],
    }) ?? '', /approvals are missing/);
  });
});
