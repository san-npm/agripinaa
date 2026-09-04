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
 * An outer orchestrator receipt can still be successful when its inner account
 * batch reverts. The bootstrap unwraps the user's exact WBNB reserve before its
 * venue approvals and registration. Its account-scoped Withdrawal log is an
 * on-chain success witness because a reverted atomic batch cannot retain it.
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
