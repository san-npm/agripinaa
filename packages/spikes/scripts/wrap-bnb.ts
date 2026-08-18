/**
 * Wrap native BNB into WBNB (1:1 deposit on the canonical WBNB contract).
 * Not a trade: token conversions go through Ophis; the EOA agent path is
 * ERC-20 only, so native BNB must be wrapped before it can be sold.
 *
 * Usage: pnpm --filter @agripinaa/spikes exec tsx scripts/wrap-bnb.ts <wallet-name> <bnb-amount>
 */
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { BSC_MAINNET, TOKENS_BSC } from '@agripinaa/shared';
import { loadWallet } from '../src/wallet-store';

const [name, amount] = [process.argv[2], process.argv[3]];
if (!name || !amount) {
  console.error('Usage: tsx scripts/wrap-bnb.ts <wallet-name> <bnb-amount>');
  process.exit(1);
}

const stored = await loadWallet(name);
const account = privateKeyToAccount(stored.privateKey);
const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
const publicClient = createPublicClient({ chain: bsc, transport });
const walletClient = createWalletClient({ account, chain: bsc, transport });

const value = parseEther(amount);
console.log(`wrapping ${amount} BNB → WBNB from ${account.address}…`);

const hash = await walletClient.sendTransaction({
  to: TOKENS_BSC.WBNB!.address,
  value,
  data: '0xd0e30db0', // deposit()
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`tx: ${hash} (${receipt.status})`);

const wbnb = await publicClient.readContract({
  address: TOKENS_BSC.WBNB!.address,
  abi: [
    {
      type: 'function',
      name: 'balanceOf',
      stateMutability: 'view',
      inputs: [{ type: 'address' }],
      outputs: [{ type: 'uint256' }],
    },
  ],
  functionName: 'balanceOf',
  args: [account.address],
});
console.log(`WBNB balance: ${Number(wbnb) / 1e18}`);
