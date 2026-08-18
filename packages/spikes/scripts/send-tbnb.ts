/** Send testnet BNB from spike-b. Usage: tsx scripts/send-tbnb.ts <to> <amount> */
import { createPublicClient, createWalletClient, http, parseEther, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';

import { loadWallet } from '../src/wallet-store';

const [to, amount] = [process.argv[2], process.argv[3] ?? '0.01'];
if (!to || !isAddress(to)) {
  console.error('usage: tsx scripts/send-tbnb.ts <address> [tbnb]');
  process.exit(1);
}

const stored = await loadWallet('spike-b');
const account = privateKeyToAccount(stored.privateKey);
const transport = http('https://bsc-testnet-rpc.publicnode.com');
const walletClient = createWalletClient({ account, chain: bscTestnet, transport });
const publicClient = createPublicClient({ chain: bscTestnet, transport });

const hash = await walletClient.sendTransaction({ to, value: parseEther(amount) });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`sent ${amount} tBNB → ${to}: ${receipt.status} (${hash})`);
