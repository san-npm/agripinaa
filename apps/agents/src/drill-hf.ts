/**
 * Liquidation drill: push the guarded Aave position's health factor below
 * the act threshold by borrowing extra USDT from the agent wallet, then
 * watch the agent's log for the autonomous repair. Used for the TermiX
 * report evidence and the demo video.
 *
 * Usage: pnpm --filter @agripinaa/agents exec tsx src/drill-hf.ts [borrowUsdt]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BSC_MAINNET, TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

const AAVE_POOL = '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' as const;
const POOL_ABI = parseAbi([
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

const borrowAmount = process.argv[2] ?? '0.65';
const WALLETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wallets');
const { privateKey } = JSON.parse(
  readFileSync(join(WALLETS, 'agent-health-factor.json'), 'utf8'),
) as { privateKey: `0x${string}` };

const account = privateKeyToAccount(privateKey);
const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
const publicClient = createPublicClient({ chain: bsc, transport });
const walletClient = createWalletClient({ account, chain: bsc, transport });

const hf = async () => {
  const data = await publicClient.readContract({
    address: AAVE_POOL,
    abi: POOL_ABI,
    functionName: 'getUserAccountData',
    args: [account.address],
  });
  return Number(data[5]) / 1e18;
};

console.log(`drill: HF before = ${(await hf()).toFixed(3)}`);
console.log(`drill: borrowing ${borrowAmount} extra USDT to degrade the position…`);
const hash = await walletClient.writeContract({
  address: AAVE_POOL,
  abi: POOL_ABI,
  functionName: 'borrow',
  args: [TOKENS_BSC.USDT!.address, toBaseUnits(borrowAmount, 18), BigInt(2), 0, account.address],
});
await publicClient.waitForTransactionReceipt({ hash });
console.log(`drill: borrow tx ${hash}`);
console.log(`drill: HF now = ${(await hf()).toFixed(3)} (agent should repair within 2 ticks)`);

const deadline = Date.now() + 5 * 60_000;
let last = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000));
  const current = await hf();
  if (current !== last) console.log(`drill: HF = ${current.toFixed(3)}`);
  last = current;
  if (current >= 1.55) {
    console.log('drill: PASSED, agent repaired the position autonomously.');
    process.exit(0);
  }
}
console.error('drill: TIMEOUT, agent did not repair within 5 minutes.');
process.exit(1);
