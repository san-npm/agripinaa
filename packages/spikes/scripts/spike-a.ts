/**
 * Spike A: prove a real Ophis swap on BSC (chain 56) end to end from an
 * agent-style EOA, using the exact stack the reference agents will use
 * (@ophis/agent-swap over the 5-method wallet interface).
 *
 * Prereqs:
 *   1. pnpm gen-wallet spike-a
 *   2. Fund the printed address on BSC: ~0.01 BNB (gas for one approve)
 *      + ~12 USDT (sell side).
 *   3. pnpm spike-a
 *
 * Verifies afterwards: order fill status, account order history on
 * api.cow.fi/bnb, and rebate-indexer enrollment.
 */
import { executeOphisSwap } from '@ophis/agent-swap';
import { getOphisOrderbookUrl } from '@ophis/sdk';

import { TOKENS_BSC } from '@agripinaa/shared';
import { ViemAgentWallet } from '../src/viem-agent-wallet';
import { loadWallet } from '../src/wallet-store';

const SELL_USDT = '10';
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stored = await loadWallet('spike-a');
  const wallet = new ViemAgentWallet(stored.privateKey);
  console.log(`spike-a wallet: ${wallet.getAddress()} (chain ${wallet.getChainId()})`);

  const result = await executeOphisSwap(
    wallet,
    {
      sellToken: TOKENS_BSC.USDT!.address,
      buyToken: TOKENS_BSC.WBNB!.address,
      sellAmount: SELL_USDT,
      slippageBps: 50,
    },
    {},
  );

  console.log('order submitted:');
  console.log(`  uid:      ${result.orderUid}`);
  console.log(`  explorer: ${result.explorerUrl}`);
  if (result.enrollmentWarning) {
    console.warn(`  enrollment warning: ${result.enrollmentWarning}`);
  }

  const orderbook = getOphisOrderbookUrl(56);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status = 'unknown';
  while (Date.now() < deadline) {
    const res = await fetch(`${orderbook}/api/v1/orders/${result.orderUid}`);
    if (res.ok) {
      const order = (await res.json()) as {
        status: string;
        executedBuyAmount?: string;
        executedSellAmount?: string;
      };
      status = order.status;
      console.log(`  status: ${status}`);
      if (status === 'fulfilled') {
        console.log(`  executedSellAmount: ${order.executedSellAmount}`);
        console.log(`  executedBuyAmount:  ${order.executedBuyAmount}`);
        break;
      }
      if (status === 'cancelled' || status === 'expired') break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.log('\nverification:');
  const owner = wallet.getAddress();
  const history = await fetch(
    `${orderbook}/api/v1/account/${owner}/orders?limit=5`,
  ).then((r) => r.json() as Promise<unknown[]>);
  console.log(`  account orders on api.cow.fi/bnb: ${history.length}`);
  const tier = await fetch(`https://rebates.ophis.fi/tier/${owner}`, {
    headers: { accept: 'application/json' },
  });
  console.log(`  rebate-indexer /tier: HTTP ${tier.status} (enrolled)`);

  if (status !== 'fulfilled') {
    console.error(`\nRESULT: order did NOT fill (final status: ${status}).`);
    process.exit(1);
  }
  console.log('\nRESULT: Spike A PASSED, Ophis executes on BSC end to end.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
