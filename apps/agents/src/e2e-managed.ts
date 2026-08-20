/**
 * End-to-end proof, on BNB mainnet with real funds, that an Agripinaa agent
 * actually manages a user's money:
 *
 *   1. A user smart account (here: a private-key account standing in for the
 *      passkey one) approves the drain-proof YieldRouter.
 *   2. It grants a router-scoped session to the yield agent's manager key via a
 *      verify-only stub (the agent key never enters the "browser").
 *   3. The REAL managedYieldTick runs: it reads Venus/Aave live, decides, and
 *      the agent moves the user's USDT into the winning venue via the router.
 *   4. We confirm on-chain the funds are now in a venue, in the USER's account.
 *   5. The user withdraws (toIdle) and we confirm the USDT is back.
 *   6. Revoke, and confirm the agent can no longer act.
 *
 * Run: pnpm --filter @agripinaa/agents exec tsx src/e2e-managed.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BSC_MAINNET, ROUTER_ACTIONS, YIELD_ROUTER_BSC } from '@agripinaa/shared';
import { signerFromPrivateKey } from '@altananetwork/sdk';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  http,
  maxUint256,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { managedYieldTick } from './agents/yield';
import { createAltanaClient, managedExecutor } from './executor';
import { loadManagerKey } from './manager-key';
import type { ManagedAccount } from './managed';
import type { AgentContext } from './types';

const WALLETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wallets');
const R = YIELD_ROUTER_BSC;
const vTokenRead = parseAbi(['function balanceOfUnderlying(address) view returns (uint256)']);
const usd = (v: bigint) => (Number(v) / 1e18).toFixed(4);

function loadKey(name: string): Hex {
  return (JSON.parse(readFileSync(join(WALLETS, `${name}.json`), 'utf8')) as { privateKey: Hex }).privateKey;
}

/** Minimal ctx: managedYieldTick needs only these fields. */
function minimalCtx(): AgentContext {
  const store = new Map<string, unknown>();
  const publicClient = createPublicClient({
    chain: bsc,
    transport: fallback(BSC_MAINNET.rpcUrls.map((u) => http(u))),
  });
  return {
    name: 'yield',
    chainId: 56,
    account: { address: '0x0000000000000000000000000000000000000000' },
    publicClient,
    walletClient: {},
    log: (e) => console.log('   [tick]', JSON.stringify(e)),
    state: {
      get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f),
      set: (k, v) => void store.set(k, v),
    },
    breakers: {
      halt() {},
      isHalted: () => ({ halted: false }),
      allowAction: () => true,
    },
  } as unknown as AgentContext;
}

async function readPosition(client: ReturnType<typeof createPublicClient>, account: Hex) {
  const [idle, aUsdt, venus] = await Promise.all([
    client.readContract({ address: R.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: R.aUsdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: R.vUsdt, abi: vTokenRead, functionName: 'balanceOfUnderlying', args: [account] }),
  ]);
  return { idle, aUsdt, venus };
}

async function main() {
  const client = createAltanaClient();
  const ctx = minimalCtx();
  const pub = ctx.publicClient as ReturnType<typeof createPublicClient>;

  const userPk = loadKey('spike-b');
  const adminSigner = signerFromPrivateKey(userPk);
  const manager = loadManagerKey('yield');
  if (!manager) throw new Error('no wallets/agent-yield-session.json; run fund --gen');

  console.log('1) reconstruct the user smart account…');
  const wallet = await client.createWallet({ signer: adminSigner });
  const account = wallet.address as Hex;
  const before = await readPosition(pub, account);
  console.log(`   account ${account}`);
  console.log(`   idle=${usd(before.idle)} aave=${usd(before.aUsdt)} venus=${usd(before.venus)} USDT`);
  if (before.idle < 10n ** 18n && before.aUsdt < 10n ** 16n && before.venus < 10n ** 16n) {
    throw new Error('account has < ~1 USDT to manage; fund it first');
  }

  console.log('2) approve the router for USDT + aUSDT + vUSDT (one batched admin tx)…');
  const approve = (token: Hex) => ({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [R.address, maxUint256] }),
  });
  const appr = await client.execute({
    wallet,
    signer: adminSigner,
    chainId: 56,
    calls: [approve(R.usdt), approve(R.aUsdt), approve(R.vUsdt)],
  });
  console.log(`   ${appr.status} ${appr.transactionHash ?? ''}`);

  console.log('3) grant a router-scoped session to the agent manager key (verify-only stub)…');
  const permissions = {
    calls: Object.values(ROUTER_ACTIONS).map((a) => ({ signature: a.signature, to: R.address })),
    spend: [
      { limit: 30n * 10n ** 18n, period: 'day' as const, token: R.usdt },
      { limit: 2n * 10n ** 16n, period: 'day' as const }, // 0.02 BNB gas
    ],
  };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const stub = {
    type: 'privateKey' as const,
    address: manager.address,
    publicKey: manager.publicKey,
    signDigest: () => {
      throw new Error('verify-only');
    },
  };
  await client.grantSession({ wallet, signer: adminSigner, chainId: 56, sessionSigner: stub as never, permissions, expiry });
  console.log(`   granted to ${manager.address}`);

  console.log('4) the AGENT manages the funds: running the real managedYieldTick…');
  const entry: ManagedAccount = {
    account,
    chainId: 56,
    session: { walletAddress: account, publicKey: manager.publicKey, permissions, expiry },
    registeredAt: new Date().toISOString(),
  };
  const executor = managedExecutor({ client, managerKey: manager.privateKey, entry });
  await managedYieldTick(ctx, executor);

  const afterEnter = await readPosition(pub, account);
  console.log(`   idle=${usd(afterEnter.idle)} aave=${usd(afterEnter.aUsdt)} venus=${usd(afterEnter.venus)} USDT`);
  const deployed = afterEnter.aUsdt + afterEnter.venus;
  if (deployed < 10n ** 18n) throw new Error('E2E FAIL: funds were not deployed into a venue');
  const venue = afterEnter.aUsdt >= afterEnter.venus ? 'Aave' : 'Venus';
  console.log(`   ✓ agent moved ~${usd(deployed)} USDT into ${venue}, held in the USER's account`);

  console.log('5) user withdraws (toIdle) — unwind back to plain USDT…');
  const idleTx = await client.execute({
    session: { walletAddress: account, signer: signerFromPrivateKey(manager.privateKey), publicKey: manager.publicKey, permissions, expiry } as never,
    chainId: 56,
    calls: [{ to: R.address, data: ROUTER_ACTIONS.toIdle.selector as Hex }],
  });
  console.log(`   ${idleTx.status} ${idleTx.transactionHash ?? ''}`);
  const afterIdle = await readPosition(pub, account);
  console.log(`   idle=${usd(afterIdle.idle)} aave=${usd(afterIdle.aUsdt)} venus=${usd(afterIdle.venus)} USDT`);
  if (afterIdle.idle < 10n ** 18n) throw new Error('E2E FAIL: funds did not return to idle USDT');
  console.log(`   ✓ ${usd(afterIdle.idle)} USDT back in the user's account`);

  console.log('6) revoke the session — the agent must no longer be able to act…');
  await client.revokeSession({
    wallet,
    signer: adminSigner,
    chainId: 56,
    session: { walletAddress: account, signer: signerFromPrivateKey(manager.privateKey), publicKey: manager.publicKey, permissions, expiry } as never,
  });
  try {
    await executor.execute('toAave');
    throw new Error('E2E FAIL: revoked session still executed');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('E2E FAIL')) throw e;
    console.log('   ✓ revoked session correctly rejected');
  }

  console.log('\nE2E PASSED: an agent moved real user funds into a live yield venue,');
  console.log('the user withdrew them, and revocation cut the agent off — non-custodial,');
  console.log('drain-proof, on BNB mainnet.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
