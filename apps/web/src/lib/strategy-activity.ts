import 'server-only';

import { AGENT_LIST, type AgentRecord } from '@agripinaa/shared/agents';
import type { ProofEvent } from '@agripinaa/shared';
import { cacheLife } from 'next/cache';
import { createPublicClient, http, type TransactionReceipt } from 'viem';

import { bsc } from './bsc-chain';
import { getRunnerEvidence } from './proof';

const chain = createPublicClient({ chain: bsc, transport: http(undefined, { timeout: 3_000, retryCount: 0 }) });
export const ACTIVITY_SAMPLE_LIMIT = 5;

/** Receipts prove inclusion, not a relay's session signer. Keep reports separate
 * from transactions sent directly by the agent's pinned own-capital wallet.
 */
export async function readStrategyActivity(
  agent: AgentRecord,
  events: readonly ProofEvent[],
  readReceipt: (hash: `0x${string}`) => Promise<Pick<TransactionReceipt, 'transactionHash' | 'status' | 'from'>>,
) {
  const candidates = [...new Set([
    ...agent.proofs.map(proof => proof.ref),
    ...events.filter(event => event.agent === agent.tokenId && (event.kind === 'rotate' || event.kind === 'repair'))
      .map(event => event.txHash),
  ].filter((hash): hash is `0x${string}` => !!hash && /^0x[0-9a-fA-F]{64}$/.test(hash))
    .map(hash => hash.toLowerCase() as `0x${string}`))].slice(0, ACTIVITY_SAMPLE_LIMIT);
  const checked = await Promise.allSettled(candidates.map(async hash => {
    const receipt = await readReceipt(hash);
    if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== hash) return null;
    const ownWallet = receipt.from.toLowerCase() === agent.wallet?.toLowerCase();
    if (!ownWallet && !events.some(event => event.agent === agent.tokenId && event.txHash?.toLowerCase() === hash)) return null;
    return { hash, ownWallet };
  }));
  return {
    tokenId: agent.tokenId!, name: agent.name, category: agent.category,
    receipts: checked.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []),
    unavailable: checked.some(result => result.status === 'rejected'),
  };
}

export async function getStrategyActivity() {
  'use cache';
  cacheLife('minutes');
  const feed = await getRunnerEvidence().catch(() => ({ events: [], available: false }));
  return Promise.all(AGENT_LIST.filter(agent => agent.tokenId && agent.wallet
    && (agent.category === 'yield' || agent.category === 'health-factor')).map(async agent => ({
      ...await readStrategyActivity(agent, feed.events.slice(0, 40), hash => chain.getTransactionReceipt({ hash })),
      feedUnavailable: !feed.available,
    })));
}
