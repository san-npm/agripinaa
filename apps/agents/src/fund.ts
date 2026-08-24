/**
 * Wallet generation and funding for the reference agents, sized to the real
 * budget on the spike-a wallet (~12 USDT + ~0.013 WBNB + ~0.005 BNB).
 *
 * The split itself lives in the shared agent registry (see agent-config.ts), so
 * adding an agent does not mean remembering to add it here too.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS_DIR = join(ROOT, '..', '..', 'wallets');

/** The `--only` value, or undefined for the whole plan. */
function onlyArg(): string | undefined {
  const i = process.argv.indexOf('--only');
  if (i < 0) return undefined;
  return process.argv[i + 1] ?? '';
}

function describe(entry: FundingEntry): string {
  const line = `${entry.name}: ${entry.bnb} BNB + ${entry.usdt} USDT + ${entry.wbnb} WBNB`;
  return Number(entry.usdc) > 0 ? `${line} + ${entry.usdc} USDC` : line;
}

async function loadKey(name: string): Promise<`0x${string}`> {
  const { privateKey } = JSON.parse(
    await readFile(join(WALLETS_DIR, `${name}.json`), 'utf8'),
  ) as { privateKey: `0x${string}` };
  return privateKey;
}

async function main() {
  const mode = process.argv.find((a) => ['--gen', '--plan', '--execute'].includes(a)) ?? '--plan';
  const plan = selectFundingEntries(onlyArg());

  if (mode === '--gen') {
    await mkdir(WALLETS_DIR, { recursive: true });
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
        { flag: 'wx' },
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
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`${entry.name} ← ${entry.bnb} BNB (${hash})`);
    }
    for (const [symbol, amount] of [
      ['USDT', entry.usdt],
      ['WBNB', entry.wbnb],
      ['USDC', entry.usdc],
    ] as const) {
      if (Number(amount) <= 0) continue;
      const token = TOKENS_BSC[symbol]!;
      const hash = await walletClient.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [dest, toBaseUnits(amount, token.decimals)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`${entry.name} ← ${amount} ${symbol} (${hash})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
