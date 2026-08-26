/**
 * Liquidation drill: push the guarded Aave position's health factor below
 * the act threshold by borrowing extra USDT from the agent wallet, then
 * watch the agent's log for the autonomous repair. Used for the TermiX
 * report evidence and the demo video.
 *
 * Usage: pnpm --filter @agripinaa/agents exec tsx src/drill-hf.ts [borrowUsdt] --confirm-mainnet-borrow
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

import { projectedHealthFactor } from './drill-safety';

const AAVE_POOL = '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' as const;
const POOL_ABI = parseAbi([
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

const argv = process.argv.slice(2);
if (!argv.includes('--confirm-mainnet-borrow')) {
  throw new Error('refusing a mainnet borrow without --confirm-mainnet-borrow');
}
const borrowAmount = argv.find((arg) => !arg.startsWith('--')) ?? '0.65';
if (!/^\d+(?:\.\d+)?$/.test(borrowAmount) || Number(borrowAmount) <= 0) {
  throw new Error(`invalid borrow amount: ${borrowAmount}`);
}
const maxBorrow = Number(process.env.DRILL_MAX_BORROW_USDT ?? '1');
if (!Number.isFinite(maxBorrow) || Number(borrowAmount) > maxBorrow) {
  throw new Error(`borrow ${borrowAmount} exceeds DRILL_MAX_BORROW_USDT=${maxBorrow}`);
}
const minimumHealthFactor = Number(process.env.DRILL_MIN_HF ?? '1.25');
if (!Number.isFinite(minimumHealthFactor) || minimumHealthFactor < 1) {
  throw new Error(`DRILL_MIN_HF must be a finite number >= 1: ${process.env.DRILL_MIN_HF ?? ''}`);
}
const WALLETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wallets');
const { privateKey } = JSON.parse(
  readFileSync(join(WALLETS, 'agent-health-factor.json'), 'utf8'),
) as { privateKey: `0x${string}` };

const account = privateKeyToAccount(privateKey);
const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
const publicClient = createPublicClient({ chain: bsc, transport });
const walletClient = createWalletClient({ account, chain: bsc, transport });

const accountData = async () => {
  const data = await publicClient.readContract({
    address: AAVE_POOL,
    abi: POOL_ABI,
    functionName: 'getUserAccountData',
    args: [account.address],
  });
  return data;
};
const hf = async () => Number((await accountData())[5]) / 1e18;

const before = await accountData();
const addedDebtBase = BigInt(Math.ceil(Number(borrowAmount) * 1e8));
const projected = projectedHealthFactor({
  totalCollateralBase: before[0],
  totalDebtBase: before[1],
  liquidationThresholdBps: before[3],
  addedDebtBase,
});
if (!Number.isFinite(projected) || projected < minimumHealthFactor) {
  throw new Error(
    `projected HF ${projected.toFixed(3)} is below DRILL_MIN_HF=${minimumHealthFactor}; refusing borrow`,
  );
}

console.log(`drill: HF before = ${(await hf()).toFixed(3)}`);
console.log(`drill: borrowing ${borrowAmount} extra USDT to degrade the position…`);
const hash = await walletClient.writeContract({
  address: AAVE_POOL,
  abi: POOL_ABI,
  functionName: 'borrow',
  args: [TOKENS_BSC.USDT!.address, toBaseUnits(borrowAmount, 18), BigInt(2), 0, account.address],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`drill borrow reverted: ${hash}`);
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
