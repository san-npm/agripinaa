import type { Hex } from 'viem';

/** A relay failure alone does not prove an on-chain revert or unchanged funds. */
export function assertRelayConfirmed<T extends {
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  transactionHash?: Hex;
}>(result: T, action: string): T {
  if (result.status === 'CONFIRMED') return result;
  if (result.status === 'PENDING') {
    throw new Error(`${action} is not confirmed by the relay yet. Check its saved status before retrying.`);
  }
  throw new Error(`${action} failed. The relay did not confirm successful execution. Check its saved status before retrying.`);
}
