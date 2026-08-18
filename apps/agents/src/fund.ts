/**
 * Wallet generation and funding for the reference agents, sized to the real
 * budget on the spike-a wallet (~12 USDT + ~0.013 WBNB + ~0.005 BNB).
 *
 * Usage:
 *   pnpm --filter @agripinaa/agents fund -- --gen      # create missing wallets
 *   pnpm --filter @agripinaa/agents fund -- --plan     # print the split
 *   pnpm --filter @agripinaa/agents fund -- --execute  # transfer from spike-a
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS_DIR = join(ROOT, '..', '..', 'wallets');

const WALLET_NAMES = [
  'agent-grid',
  'agent-health-factor',
  'agent-yield',
  'agent-lp-range',
  'facilitator',
] as const;

/** The split of the real budget. Native gas per agent covers registration
 * (~0.0003), approvals, and protocol calls at BSC 1-gwei prices. */
const PLAN = {
  'agent-grid': { bnb: '0.0011', usdt: '5', wbnb: '0.004' },
  'agent-health-factor': { bnb: '0.0011', usdt: '2', wbnb: '0.005' },
  'agent-yield': { bnb: '0.0009', usdt: '2.5', wbnb: '0' },
  'agent-lp-range': { bnb: '0.0011', usdt: '1.5', wbnb: '0.003' },
  facilitator: { bnb: '0.0008', usdt: '0', wbnb: '0' },
} as const;

async function loadKey(name: string): Promise<`0x${string}`> {
  const { privateKey } = JSON.parse(
    await readFile(join(WALLETS_DIR, `${name}.json`), 'utf8'),
  ) as { privateKey: `0x${string}` };
  return privateKey;
}

async function main() {
  const mode = process.argv.find((a) => ['--gen', '--plan', '--execute'].includes(a)) ?? '--plan';

  if (mode === '--gen') {
    await mkdir(WALLETS_DIR, { recursive: true });
    for (const name of WALLET_NAMES) {
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
    for (const [name, amounts] of Object.entries(PLAN)) {
      console.log(`${name}: ${amounts.bnb} BNB + ${amounts.usdt} USDT + ${amounts.wbnb} WBNB`);
    }
    return;
  }

  // --execute: transfers from spike-a
  const senderKey = await loadKey('spike-a');
  const account = privateKeyToAccount(senderKey);
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain: bsc, transport });
  const walletClient = createWalletClient({ account, chain: bsc, transport });

  for (const [name, amounts] of Object.entries(PLAN)) {
    const dest = privateKeyToAccount(await loadKey(name)).address;
    if (Number(amounts.bnb) > 0) {
      const hash = await walletClient.sendTransaction({
        to: dest,
        value: toBaseUnits(amounts.bnb, 18),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`${name} ← ${amounts.bnb} BNB (${hash})`);
    }
    for (const [symbol, amount] of [['USDT', amounts.usdt], ['WBNB', amounts.wbnb]] as const) {
      if (Number(amount) <= 0) continue;
      const token = TOKENS_BSC[symbol]!;
      const hash = await walletClient.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [dest, toBaseUnits(amount, token.decimals)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`${name} ← ${amount} ${symbol} (${hash})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
