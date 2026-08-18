/** Send native BNB between spike wallets (mainnet).
 * Usage: tsx scripts/send-bnb.ts <from-wallet-name> <to-address-or-wallet-name> <bnb-amount> */
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  isAddress,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { BSC_MAINNET } from '@agripinaa/shared';
import { loadWallet } from '../src/wallet-store';

const [from, to, amount] = [process.argv[2], process.argv[3], process.argv[4]];
if (!from || !to || !amount) {
  console.error('Usage: tsx scripts/send-bnb.ts <from-wallet> <to> <bnb>');
  process.exit(1);
}

const sender = await loadWallet(from);
const dest = isAddress(to) ? to : (await loadWallet(to)).address;

const account = privateKeyToAccount(sender.privateKey);
const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
const walletClient = createWalletClient({ account, chain: bsc, transport });
const publicClient = createPublicClient({ chain: bsc, transport });

const hash = await walletClient.sendTransaction({
  to: dest,
  value: parseEther(amount),
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`sent ${amount} BNB ${account.address} → ${dest}: ${receipt.status} (${hash})`);
