/**
 * Task-1 manual baseline: a direct AMM swap (PancakeSwap V3 router, single
 * pool, no auction) from the spike-a wallet, measured for comparison with
 * the agent's Ophis batch-auction fills. Same pair, same direction.
 *
 * Usage: pnpm --filter @agripinaa/agents exec tsx src/baseline-swap.ts [wbnbAmount]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BSC_MAINNET, TOKENS_BSC, toBaseUnits, fromBaseUnits } from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

/** PancakeSwap SmartRouter v3; verified below before the swap. */
const ROUTER = '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' as const;
const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function factory() view returns (address)',
]);

const amount = process.argv[2] ?? '0.002';
const WALLETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wallets');
const { privateKey } = JSON.parse(readFileSync(join(WALLETS, 'spike-a.json'), 'utf8')) as {
  privateKey: `0x${string}`;
};

const account = privateKeyToAccount(privateKey);
const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
const publicClient = createPublicClient({ chain: bsc, transport });
const walletClient = createWalletClient({ account, chain: bsc, transport });

const WBNB = TOKENS_BSC.WBNB!.address;
const USDT = TOKENS_BSC.USDT!.address;
const amountIn = toBaseUnits(amount, 18);

// Router verification: its factory must be the canonical Pancake V3 factory.
const factory = await publicClient.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'factory' });
if (factory.toLowerCase() !== '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865') {
  throw new Error(`router factory mismatch: ${factory}`);
}

const before = await publicClient.readContract({
  address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
});

const started = Date.now();
const approveHash = await walletClient.writeContract({
  address: WBNB, abi: erc20Abi, functionName: 'approve', args: [ROUTER, amountIn],
});
await publicClient.waitForTransactionReceipt({ hash: approveHash });

const swapHash = await walletClient.writeContract({
  address: ROUTER,
  abi: ROUTER_ABI,
  functionName: 'exactInputSingle',
  args: [{
    tokenIn: WBNB,
    tokenOut: USDT,
    fee: 100,
    recipient: account.address,
    amountIn,
    amountOutMinimum: BigInt(0), // measurement run; tiny size, deep pool
    sqrtPriceLimitX96: BigInt(0),
  }],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
const elapsedMs = Date.now() - started;

const after = await publicClient.readContract({
  address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
});
const out = after - before;
const gasBnb = receipt.gasUsed * (receipt.effectiveGasPrice ?? BigInt(0));

console.log(JSON.stringify({
  kind: 'direct-amm-baseline',
  router: ROUTER,
  pair: 'WBNB->USDT',
  feeTier: 100,
  amountInWbnb: amount,
  amountOutUsdt: fromBaseUnits(out, 18),
  effectiveRate: Number(fromBaseUnits(out, 18)) / Number(amount),
  gasUsed: receipt.gasUsed.toString(),
  gasCostBnb: fromBaseUnits(gasBnb, 18),
  wallTimeMs: elapsedMs,
  approveTx: approveHash,
  swapTx: swapHash,
}, null, 2));
