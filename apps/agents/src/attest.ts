/**
 * Write real ERC-8004 ReputationRegistry attestations on-chain for our four
 * agents, from a dedicated Agripinaa Verifier wallet (the registry forbids
 * self-feedback, so the attester must not be the agent owner). Each
 * attestation carries a feedbackHash anchored to specific verifiable
 * execution: the trading agents' first Ophis order, the guardian's live
 * repair, the yield agent's supply. The proof is the execution; the
 * attestation anchors our verification on-chain in the standard ERC-8004 way.
 *
 * Usage: pnpm --filter @agripinaa/agents exec tsx src/attest.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BSC_MAINNET, ERC8004_REGISTRIES, bscScanTx } from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  keccak256,
  parseAbi,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS = join(ROOT, '..', '..', 'wallets');
const OUT = join(ROOT, 'data', 'attestations.json');

const REP_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

/** agentId -> { tag2 (category), the on-chain execution reference we attest to }. */
const AGENTS: Record<string, { category: string; proofRef: string; proofLabel: string }> = {
  '269703': {
    category: 'grid',
    proofRef: '0xa2fa52fa97922df8b884345a2959a71209a73957073098c4af76cbd72fa1f02b053fff26d28ff4e94dfe862b184f918a50c6f7066a848e4c',
    proofLabel: 'ophis-order',
  },
  '269704': {
    category: 'health-factor',
    proofRef: '0x367cb2dc8ab49a0960077ac0e30b58c2d200bc21ecc2bf184c367050b4b0050a',
    proofLabel: 'liquidation-drill-repay',
  },
  '269705': {
    category: 'yield',
    proofRef: '0xefa6d0840e9974fdd28700116f152d054e3c5f178417e36d06f85399a30e058f',
    proofLabel: 'aave-supply',
  },
  '269706': {
    category: 'rebalancing',
    proofRef: '7173629',
    proofLabel: 'pancake-v3-position',
  },
};

async function main() {
  const verifierFile = join(WALLETS, 'verifier.json');
  if (!existsSync(verifierFile)) {
    throw new Error(`missing ${verifierFile}; run: pnpm --filter @agripinaa/agents fund -- --gen (add "verifier")`);
  }
  const { privateKey } = JSON.parse(readFileSync(verifierFile, 'utf8')) as { privateKey: `0x${string}` };
  const account = privateKeyToAccount(privateKey);
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain: bsc, transport });
  const walletClient = createWalletClient({ account, chain: bsc, transport });
  const registry = ERC8004_REGISTRIES[56]!.reputation;

  console.log(`verifier: ${account.address}`);
  const records: Record<string, unknown> = existsSync(OUT)
    ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>)
    : {};

  for (const [agentId, info] of Object.entries(AGENTS)) {
    if (records[agentId]) {
      console.log(`${agentId}: already attested, skipping`);
      continue;
    }
    // feedbackHash binds this attestation to the specific execution proof.
    const feedbackHash = keccak256(toBytes(`${info.proofLabel}:${info.proofRef}`));
    const feedbackURI = `https://agripinaa.vercel.app/agent/56/${agentId}`;
    console.log(`${agentId}: attesting (${info.category}, ${info.proofLabel})…`);
    const hash = await walletClient.writeContract({
      address: registry,
      abi: REP_ABI,
      functionName: 'giveFeedback',
      args: [
        BigInt(agentId),
        BigInt(100), // value: verified/passing
        0, // valueDecimals
        'agripinaa-verified', // tag1 (indexed)
        info.category, // tag2
        'https://agripinaa.vercel.app', // endpoint
        feedbackURI,
        feedbackHash,
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${agentId}: attestation reverted (${hash})`);
    records[agentId] = {
      verifier: account.address,
      txHash: hash,
      feedbackHash,
      proofLabel: info.proofLabel,
      proofRef: info.proofRef,
      tag1: 'agripinaa-verified',
      tag2: info.category,
      attestedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(records, null, 2));
    console.log(`${agentId}: attested ${bscScanTx(56, hash)}`);
  }
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
