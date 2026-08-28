import { ALTANA_ORCHESTRATOR_BSC } from '@agripinaa/shared/funding';
import type { ManagedApproval } from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import {
  decodeEventLog,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

import type { FundingReceiptLog } from './funding-receipt';

const APPROVAL_EVENTS = parseAbi([
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);

export interface FundingRecoveryReceipt {
  status: 'success' | 'reverted';
  to: Address | null;
  logs: readonly FundingReceiptLog[];
}

/** Strictly parse a BNB Chain transaction hash supplied through a recovery link. */
export function fundingRecoveryHash(value: string): Hex | null {
  const candidate = value.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(candidate) ? candidate as Hex : null;
}

/**
 * A manual recovery must prove more than a successful outer relay receipt.
 * Every owner-authorized venue approval is appended after the atomic funding
 * calls, so their exact account, token, spender, and max allowance form a
 * strategy-specific on-chain witness. The recovered passkey account must own
 * those approvals, preventing a transaction copied from another user from
 * being resumed.
 */
export function receiptProvesStrategyFundingRecovery(
  receipt: FundingRecoveryReceipt,
  account: Address,
  approvals: readonly ManagedApproval[],
): boolean {
  if (
    receipt.status !== 'success'
    || receipt.to?.toLowerCase() !== ALTANA_ORCHESTRATOR_BSC.toLowerCase()
    || approvals.length === 0
  ) return false;

  const required = new Set<string>();
  for (const approval of approvals) {
    const token = TOKENS_BSC[approval.token]?.address;
    if (!token) return false;
    required.add(`${token.toLowerCase()}:${approval.spender.toLowerCase()}`);
  }

  const witnessed = new Set<string>();
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: APPROVAL_EVENTS,
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
      });
      if (
        decoded.eventName !== 'Approval'
        || decoded.args.owner.toLowerCase() !== account.toLowerCase()
        || decoded.args.value !== maxUint256
      ) continue;
      witnessed.add(`${log.address.toLowerCase()}:${decoded.args.spender.toLowerCase()}`);
    } catch {
      // Ignore unrelated and malformed logs; every required witness must decode.
    }
  }

  return required.size === witnessed.size
    && [...required].every((approval) => witnessed.has(approval));
}
