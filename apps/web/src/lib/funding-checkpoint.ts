'use client';

import { isFundingAsset, type FundingToken } from '@agripinaa/shared/funding';
import type { Address, Hex } from 'viem';

import type { FundingBootstrapPlan } from './funding-bootstrap';

const KEY_PREFIX = 'agripinaa.funding-bootstrap.v3';
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})+$/;
const FUNDING_TOKENS = new Set<FundingToken>(['BTCB', 'USDT', 'USDC', 'WBNB']);

interface StoredFundingPlan {
  input: unknown;
  grossInput: unknown;
  gasReserveInput: unknown;
  bootstrapFeeInput: unknown;
  nativeReserveOutputWei: unknown;
  strategyInput: unknown;
  targets: unknown;
  estimatedOutputs: unknown;
  minimumOutputs: unknown;
}

interface StoredFundingCheckpoint {
  version: 3;
  status: unknown;
  callsId: unknown;
  transactionHash?: unknown;
  plan: StoredFundingPlan;
  expectedTotalWei?: unknown;
  receiptBlockNumber?: unknown;
  reservePadding?: unknown;
}

interface FundingCheckpointBase {
  callsId: Hex;
  plan: FundingBootstrapPlan;
  expectedTotalWei?: bigint;
}

/** Durable immediately after the relay accepts the signed bundle. */
export interface SubmittedFundingCheckpoint extends FundingCheckpointBase {
  status: 'submitted';
}

/** Durable only after the inner funding-batch witness is proven in the receipt. */
export interface ConfirmedFundingCheckpoint extends FundingCheckpointBase {
  status: 'confirmed';
  transactionHash: Hex;
  receiptBlockNumber: bigint;
}

export type FundingCheckpoint = SubmittedFundingCheckpoint | ConfirmedFundingCheckpoint;

const RESERVED_CALLS_ID = `0x${'ff'.repeat(64)}`;
// The relay currently returns a bytes32 id. Keep ample headroom so replacing a
// reservation with any valid future id cannot need additional quota after the
// signed bundle has already left the browser.
const CHECKPOINT_RESERVE_PADDING = '0'.repeat(4 * 1024);

function key(chainId: number, account: Address, agent: string): string {
  return `${KEY_PREFIX}:${chainId}:${account.toLowerCase()}:${encodeURIComponent(agent)}`;
}

function decimal(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function outputs(value: unknown): Partial<Record<FundingToken, bigint>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const parsed: Partial<Record<FundingToken, bigint>> = {};
  for (const [token, amount] of Object.entries(value)) {
    if (!FUNDING_TOKENS.has(token as FundingToken)) return undefined;
    const next = decimal(amount);
    if (next === undefined) return undefined;
    parsed[token as FundingToken] = next;
  }
  return parsed;
}

function parseCheckpoint(value: unknown): FundingCheckpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const stored = value as StoredFundingCheckpoint;
  if (
    stored.version !== 3
    || (stored.status !== 'submitted' && stored.status !== 'confirmed')
    || typeof stored.callsId !== 'string'
    || !HEX_RE.test(stored.callsId)
    || typeof stored.plan !== 'object'
    || stored.plan === null
  ) return null;

  const plan = stored.plan;
  const grossInput = decimal(plan.grossInput);
  const gasReserveInput = decimal(plan.gasReserveInput);
  const bootstrapFeeInput = decimal(plan.bootstrapFeeInput);
  const nativeReserveOutputWei = decimal(plan.nativeReserveOutputWei);
  const strategyInput = decimal(plan.strategyInput);
  const estimatedOutputs = outputs(plan.estimatedOutputs);
  const minimumOutputs = outputs(plan.minimumOutputs);
  const targets = Array.isArray(plan.targets)
    && plan.targets.length > 0
    && plan.targets.every((target) => FUNDING_TOKENS.has(target as FundingToken))
    ? plan.targets as FundingToken[]
    : undefined;
  if (
    !isFundingAsset(plan.input)
    || grossInput === undefined
    || gasReserveInput === undefined
    || bootstrapFeeInput === undefined
    || nativeReserveOutputWei === undefined
    || strategyInput === undefined
    || !targets
    || !estimatedOutputs
    || !minimumOutputs
  ) return null;

  const expectedTotalWei = stored.expectedTotalWei === undefined
    ? undefined
    : decimal(stored.expectedTotalWei);
  if (stored.expectedTotalWei !== undefined && expectedTotalWei === undefined) return null;

  const restoredPlan: FundingBootstrapPlan = {
    // Executable calls are never restored. A submitted checkpoint can only be
    // polled by callsId; a confirmed checkpoint can only continue activation.
    calls: [],
    preCalls: [],
    input: plan.input,
    grossInput,
    gasReserveInput,
    bootstrapFeeInput,
    nativeReserveOutputWei,
    strategyInput,
    targets,
    estimatedOutputs,
    minimumOutputs,
  };
  const base = {
    callsId: stored.callsId as Hex,
    plan: restoredPlan,
    ...(expectedTotalWei === undefined ? {} : { expectedTotalWei }),
  };
  if (stored.status === 'submitted') return { ...base, status: 'submitted' };

  const receiptBlockNumber = decimal(stored.receiptBlockNumber);
  if (
    typeof stored.transactionHash !== 'string'
    || !HASH_RE.test(stored.transactionHash)
    || receiptBlockNumber === undefined
  ) return null;
  return {
    ...base,
    status: 'confirmed',
    transactionHash: stored.transactionHash as Hex,
    receiptBlockNumber,
  };
}

export function loadFundingCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
): FundingCheckpoint | null {
  const storageKey = key(chainId, account, agent);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const checkpoint = parseCheckpoint(JSON.parse(raw));
    if (!checkpoint) window.localStorage.removeItem(storageKey);
    return checkpoint;
  } catch {
    return null;
  }
}

function storedPlan(plan: FundingBootstrapPlan): StoredFundingPlan {
  return {
    input: plan.input,
    grossInput: plan.grossInput.toString(),
    gasReserveInput: plan.gasReserveInput.toString(),
    bootstrapFeeInput: plan.bootstrapFeeInput.toString(),
    nativeReserveOutputWei: plan.nativeReserveOutputWei.toString(),
    strategyInput: plan.strategyInput.toString(),
    targets: [...plan.targets],
    estimatedOutputs: Object.fromEntries(
      Object.entries(plan.estimatedOutputs).map(([token, amount]) => [token, amount.toString()]),
    ),
    minimumOutputs: Object.fromEntries(
      Object.entries(plan.minimumOutputs).map(([token, amount]) => [token, amount.toString()]),
    ),
  };
}

/**
 * Reserve the real checkpoint key before the passkey ceremony. The later
 * submitted record is smaller and atomically replaces this value, so a nearly
 * full localStorage cannot accept the relay transaction and then lose its id.
 */
export function assertFundingCheckpointWritable(
  chainId: number,
  account: Address,
  agent: string,
  plan: FundingBootstrapPlan,
  expectedTotalWei?: bigint,
): void {
  const reservation: StoredFundingCheckpoint = {
    version: 3,
    status: 'reserved',
    callsId: RESERVED_CALLS_ID,
    plan: storedPlan(plan),
    ...(expectedTotalWei === undefined ? {} : { expectedTotalWei: expectedTotalWei.toString() }),
    reservePadding: CHECKPOINT_RESERVE_PADDING,
  };
  window.localStorage.setItem(key(chainId, account, agent), JSON.stringify(reservation));
}

export function saveFundingCheckpoint(
  chainId: number,
  account: Address,
  agent: string,
  checkpoint: FundingCheckpoint,
): void {
  const { plan } = checkpoint;
  const stored: StoredFundingCheckpoint = {
    version: 3,
    status: checkpoint.status,
    callsId: checkpoint.callsId,
    plan: storedPlan(plan),
    ...(checkpoint.expectedTotalWei === undefined
      ? {}
      : { expectedTotalWei: checkpoint.expectedTotalWei.toString() }),
    ...(checkpoint.status === 'confirmed'
      ? {
          transactionHash: checkpoint.transactionHash,
          receiptBlockNumber: checkpoint.receiptBlockNumber.toString(),
        }
      : {}),
  };
  window.localStorage.setItem(key(chainId, account, agent), JSON.stringify(stored));
}

export function clearFundingCheckpoint(chainId: number, account: Address, agent: string): void {
  try {
    window.localStorage.removeItem(key(chainId, account, agent));
  } catch {
    // A successful activation must not be reported as failed only because the
    // browser refused cleanup. The durable session remains visible/revocable.
  }
}
