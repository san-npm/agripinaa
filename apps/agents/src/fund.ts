/**
 * Wallet generation and funding for the reference agents, sized to the actual
 * budget on the spike-a wallet (~12 USDT + ~0.013 WBNB + ~0.005 BNB).
 *
 * The split itself lives in the shared agent registry (see agent-config.ts), so
 * adding an agent does not mean remembering to add it here too.
 *
 * grid-b's plan asks for a BTCB leg, which spike-a does not hold: that leg has
 * to be acquired before --execute reaches it, or the transfer reverts on an
 * insufficient balance partway through the run (funding is not idempotent, so a
 * retry then needs --only for the wallets that were missed).
 *
 * Usage:
 *   pnpm --filter @agripinaa/agents fund -- --gen      # create missing wallets
 *   pnpm --filter @agripinaa/agents fund -- --plan     # print the split
 *   pnpm --filter @agripinaa/agents fund -- --execute  # transfer from spike-a
 *
 * Add `--only agent-grid[,facilitator]` to any mode to narrow it to named
 * wallets. Funding is NOT idempotent, so funding a newly added agent must use
 * --only or it re-sends to every already-funded wallet.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BSC_MAINNET, TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  http,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { selectFundingEntries, type FundingEntry } from './agent-config';
import { parseFundingArgs } from './fund-cli';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS_DIR = join(ROOT, '..', '..', 'wallets');

/**
 * Every ERC20 leg the plan can carry, in the order --execute sends them, each
 * paired with the TOKENS_BSC symbol it transfers as.
 *
 * ONE list, read by both the printer and the transfer loop below, so a leg
 * cannot be budgeted and printed and then silently never sent. That is not
 * hypothetical: USDC was in the plan and missing from the loop, so grid-b's
 * whole buy side would have been funded on paper and empty on chain. Adding a
 * field to FundingEntry without adding it here now leaves it out of BOTH, which
 * at least fails visibly at the plan.
 */
const ERC20_LEGS: readonly [symbol: 'USDT' | 'WBNB' | 'USDC' | 'BTCB', of: (e: FundingEntry) => string][] = [
  ['USDT', (e) => e.usdt],
  ['WBNB', (e) => e.wbnb],
  ['USDC', (e) => e.usdc],
  ['BTCB', (e) => e.btcb],
];

/** The legs of this entry that carry a non-zero amount. */
function legs(entry: FundingEntry): { symbol: 'USDT' | 'WBNB' | 'USDC' | 'BTCB'; amount: string }[] {
  return ERC20_LEGS.map(([symbol, of]) => ({ symbol, amount: of(entry) })).filter(
    (leg) => Number(leg.amount) > 0,
  );
}

function describe(entry: FundingEntry): string {
  const parts = legs(entry).map((leg) => `${leg.amount} ${leg.symbol}`);
  return [`${entry.name}: ${entry.bnb} BNB`, ...parts].join(' + ');
}

async function loadKey(name: string): Promise<`0x${string}`> {
  const { privateKey } = JSON.parse(
    await readFile(join(WALLETS_DIR, `${name}.json`), 'utf8'),
  ) as { privateKey: `0x${string}` };
  return privateKey;
}

async function main() {
  // Parse the entire command line before reading a sender key or constructing
  // transfers. Funding is non-idempotent, so a typo must never widen --only to
  // the full plan, and conflicting modes must never silently pick one.
  const { mode, only } = parseFundingArgs(process.argv.slice(2));
  const plan = selectFundingEntries(only);

  if (mode === '--gen') {
    await mkdir(WALLETS_DIR, { recursive: true, mode: 0o700 });
    await chmod(WALLETS_DIR, 0o700);
    const names = [
      ...plan.map((entry) => entry.name),
      ...plan.flatMap((entry) => (entry.sessionKey ? [entry.sessionKey] : [])),
    ];
    for (const name of names) {
      const file = join(WALLETS_DIR, `${name}.json`);
      if (existsSync(file)) {
        console.log(`${name}: exists`);
        continue;
      }
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      await writeFile(
        file,
        JSON.stringify({ name, address: account.address, privateKey, createdAt: new Date().toISOString() }, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      await chmod(file, 0o600);
      console.log(`${name}: ${account.address}`);
    }
    return;
  }

  if (mode === '--plan') {
    for (const entry of plan) {
      console.log(describe(entry));
    }
    return;
  }

  // --execute: transfers from spike-a
  const senderKey = await loadKey('spike-a');
  const account = privateKeyToAccount(senderKey);
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain: bsc, transport });
  const walletClient = createWalletClient({ account, chain: bsc, transport });

  for (const entry of plan) {
    const dest = privateKeyToAccount(await loadKey(entry.name)).address;
    if (Number(entry.bnb) > 0) {
      const hash = await walletClient.sendTransaction({
        to: dest,
        value: toBaseUnits(entry.bnb, 18),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`BNB funding reverted: ${hash}`);
      console.log(`${entry.name} ← ${entry.bnb} BNB (${hash})`);
    }
    for (const { symbol, amount } of legs(entry)) {
      const token = TOKENS_BSC[symbol]!;
      const hash = await walletClient.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [dest, toBaseUnits(amount, token.decimals)],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${symbol} funding reverted: ${hash}`);
      console.log(`${entry.name} ← ${amount} ${symbol} (${hash})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
