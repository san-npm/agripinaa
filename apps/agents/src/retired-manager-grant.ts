import type { RetiredManagerGrant } from '@agripinaa/shared/agents';
import { isSessionKeyValid, wasSessionKeyRegistered } from '@agripinaa/session-kit/verify';
import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';

import { createQuorumPublicClient } from './quorum-client';

const ALTANA_RELAY_URL = 'https://relay.altana.network';
const NONCE_ABI = parseAbi(['function getNonce(uint192 seqKey) view returns (uint256)']);

/** The old intent is impossible once its nonce lane has advanced past it. */
export async function retiredGrantNonceIsInvalid(
  grant: RetiredManagerGrant,
  client: Pick<PublicClient, 'readContract'> = createQuorumPublicClient(),
): Promise<boolean> {
  const nonce = BigInt(grant.nonce);
  const current = await client.readContract({
    address: grant.account as Address,
    abi: NONCE_ABI,
    functionName: 'getNonce',
    args: [nonce >> 64n],
  });
  return current > nonce;
}

/** A failed relay result is final; every other state remains unsafe. */
export async function retiredGrantFailedAtRelay(
  grant: RetiredManagerGrant,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(ALTANA_RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'wallet_getCallsStatus',
      params: [grant.grantCallsId],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`retired manager relay status failed (${response.status})`);
  const body = await response.json() as { result?: unknown };
  if (typeof body.result !== 'object' || body.result === null || Array.isArray(body.result)) {
    throw new Error('retired manager relay status is unreadable');
  }
  const result = body.result as { id?: unknown; status?: unknown };
  if (
    typeof result.id !== 'string'
    || result.id.toLowerCase() !== grant.grantCallsId.toLowerCase()
    || (typeof result.status !== 'number' && typeof result.status !== 'string')
  ) throw new Error('retired manager relay status is unreadable');
  return result.status === 500 || result.status === 'FAILED';
}

/** Block overlapping authority until the old grant is provably impossible. */
export async function retiredManagerConflict(input: {
  account: Address;
  managerToken: string;
  retired: readonly RetiredManagerGrant[];
  nowSeconds?: number;
}, deps: {
  isValid?: typeof isSessionKeyValid;
  wasRegistered?: typeof wasSessionKeyRegistered;
  nonceInvalid?: typeof retiredGrantNonceIsInvalid;
  relayFailed?: typeof retiredGrantFailedAtRelay;
} = {}): Promise<boolean> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const isValid = deps.isValid ?? isSessionKeyValid;
  const wasRegistered = deps.wasRegistered ?? wasSessionKeyRegistered;
  const nonceInvalid = deps.nonceInvalid ?? retiredGrantNonceIsInvalid;
  const relayFailed = deps.relayFailed ?? retiredGrantFailedAtRelay;
  const candidates = input.retired.filter((grant) =>
    grant.token === input.managerToken
    && grant.account.toLowerCase() === input.account.toLowerCase()
    && grant.expiry > nowSeconds);
  for (const grant of candidates) {
    const authority = {
      chainId: 56,
      account: grant.account as Address,
      sessionPublicKey: grant.publicKey as Hex,
    };
    if (await isValid(authority)) return true;
    if (await wasRegistered(authority)) continue;
    if (await nonceInvalid(grant)) continue;
    if (!await relayFailed(grant)) return true;
  }
  return false;
}
