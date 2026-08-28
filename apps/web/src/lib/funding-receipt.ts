import { TOKENS_BSC } from '@agripinaa/shared/tokens';
import {
  decodeEventLog,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

const WBNB_EVENTS = parseAbi([
  'event Withdrawal(address indexed src,uint256 wad)',
]);

export interface FundingReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
}

/**
 * Merchant pre-calls survive a failed main intent, while an outer orchestrator
 * receipt can still be successful. The main bootstrap atomically unwraps the
 * user's exact WBNB reserve before its venue approvals and registration. Its
 * account-scoped Withdrawal log is therefore an on-chain success witness: a
 * reverted main batch cannot retain this log, and the reimbursement pre-call
 * emits its separate withdrawal from the Pancake router instead.
 */
export function receiptProvesFundingMainBatch(
  logs: readonly FundingReceiptLog[],
  account: Address,
  nativeReserveOutputWei: bigint,
): boolean {
  if (nativeReserveOutputWei === 0n) return true;
  const wbnb = TOKENS_BSC.WBNB!.address.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== wbnb) continue;
    try {
      const decoded = decodeEventLog({
        abi: WBNB_EVENTS,
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
      });
      if (
        decoded.eventName === 'Withdrawal'
        && decoded.args.src.toLowerCase() === account.toLowerCase()
        && decoded.args.wad === nativeReserveOutputWei
      ) return true;
    } catch {
      // A different WBNB event is not the reserve-withdrawal witness.
    }
  }
  return false;
}
