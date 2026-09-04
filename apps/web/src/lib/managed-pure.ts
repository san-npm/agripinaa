import { agentBySlug, agentByTokenId } from '@agripinaa/shared/agents';
import { isManagedContractAddress } from '@agripinaa/shared/contracts';
import { isAddress, zeroAddress } from 'viem';
import type { Hex } from 'viem';

/** Pure validation shared by the recovery UI and its Node tests. */
export function destinationProblem(to: string, account: string, chainId: number): string | null {
  if (!isAddress(to)) return 'Enter a valid destination address.';
  const lc = to.toLowerCase();
  if (lc === zeroAddress) return 'That is the zero address; funds sent there are burned.';
  if (BigInt(lc) <= 0xffffn) return 'That is a reserved or precompile address; funds sent there may be unrecoverable.';
  if (lc === account.toLowerCase()) return 'That is this same account; enter an external wallet.';
  if (isManagedContractAddress(lc, chainId)) return 'That is a contract address, not a wallet.';
  return null;
}

/** EIP-7702 delegated EOAs retain wallet authority despite reporting 23 bytes of code. */
export function isEip7702Delegation(code: Hex | undefined): boolean {
  return /^0xef0100[0-9a-f]{40}$/i.test(code ?? '');
}

/** Live bytecode check used immediately before a full-balance withdrawal. */
export async function destinationCodeProblem(
  to: Hex,
  getCode: (address: Hex) => Promise<Hex | undefined>,
): Promise<string | null> {
  const code = await getCode(to);
  return code && code !== '0x' && !isEip7702Delegation(code)
    ? 'Contract destinations are unsupported; use an externally owned wallet.'
    : null;
}

export function destinationCodeQuorumProblem(
  codes: readonly (Hex | undefined)[],
  required = 2,
): string | null {
  const contracts = codes.filter((code) => code != null && code !== '0x' && !isEip7702Delegation(code)).length;
  const wallets = codes.filter((code) => code == null || code === '0x' || isEip7702Delegation(code)).length;
  if (contracts >= required) {
    return 'Contract destinations are unsupported; use an externally owned wallet.';
  }
  if (wallets >= required) return null;
  throw new Error('destination bytecode quorum unavailable');
}

export function shouldOfferManagedHandoffRetry(
  validity: 'checking' | 'valid' | 'invalid' | 'unknown',
  recoveryOnly: boolean,
  runner: 'checking' | 'ready' | 'halted' | 'not-registered' | 'unavailable',
  registration: 'pending' | 'registered' | undefined,
): boolean {
  return validity === 'valid'
    && !recoveryOnly
    && (registration === 'pending' || runner === 'not-registered');
}

export const MAX_ACCOUNT_HISTORY_CHUNKS = 32;
export const MAX_ACCOUNT_HISTORY_ROWS = 50;
export const ACCOUNT_HISTORY_CONCURRENCY = 4;
export const MANAGED_POSITION_DUST_WEI = 10n ** 16n;

export type ManagedVenue = 'idle' | 'venus' | 'aave' | 'split';

/** Never hide a debt-blocked partial move by naming only the larger venue. */
export function classifyManagedVenue(
  idle: bigint,
  aave: bigint,
  venus: bigint,
  dust = MANAGED_POSITION_DUST_WEI,
): ManagedVenue {
  if (aave > dust && venus > dust) return 'split';
  if (venus > aave && venus > idle) return 'venus';
  if (aave > idle) return 'aave';
  if (idle > 0n) return 'idle';
  if (venus > 0n) return 'venus';
  if (aave > 0n) return 'aave';
  return 'idle';
}

/** Build an exact, newest-first, contiguous and request-bounded log scan. */
export function planRotationHistoryRanges(
  deployBlock: bigint,
  latest: bigint,
  span: bigint,
  maxChunks = MAX_ACCOUNT_HISTORY_CHUNKS,
) {
  const ranges: { from: bigint; to: bigint }[] = [];
  if (span <= 0n || maxChunks <= 0 || latest < deployBlock) return { ranges, complete: true };
  let to = latest;
  while (to >= deployBlock && ranges.length < maxChunks) {
    const candidate = to - span + 1n;
    const from = candidate > deployBlock ? candidate : deployBlock;
    ranges.push({ from, to });
    if (from === deployBlock) break;
    to = from - 1n;
  }
  return { ranges, complete: ranges.at(-1)?.from === deployBlock };
}

export interface ManagedPolicyDisplay {
  hysteresisBps: number;
  thresholdInclusive: boolean;
  confirmations: number;
  checkEveryHours: number | null;
  minHoursBetweenMoves: number | null;
}

/** Read display promises from the selected agent's canonical manifest. */
export function managedPolicyDisplay(agent: { tokenId: string; slug?: string }): ManagedPolicyDisplay | null {
  const record = (agent.slug ? agentBySlug(agent.slug) : undefined) ?? agentByTokenId(agent.tokenId);
  const safety = record?.manifest.safety as Record<string, unknown> | undefined;
  if (!safety) return null;
  const hysteresisBps = safety['hysteresisBps'];
  const confirmations = safety['confirmations'];
  if (typeof hysteresisBps !== 'number' || typeof confirmations !== 'number') return null;
  return {
    hysteresisBps,
    thresholdInclusive: safety['thresholdComparator'] === 'inclusive',
    confirmations,
    checkEveryHours: typeof safety['checkEveryHours'] === 'number' ? safety['checkEveryHours'] : null,
    minHoursBetweenMoves:
      typeof safety['minHoursBetweenMoves'] === 'number' ? safety['minHoursBetweenMoves'] : null,
  };
}
