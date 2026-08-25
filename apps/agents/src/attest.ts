/**
 * Write ERC-8004 ReputationRegistry attestations on-chain for our
 * registered agents, from a dedicated Agripinaa Verifier wallet (the registry
 * forbids self-feedback, so the attester must not be the agent owner). Each
 * attestation carries a feedbackHash anchored to specific verifiable
 * execution: the trading agents' first Ophis order, the guardian's live
 * repair, the yield agent's supply. The proof is the execution; the
 * attestation anchors our verification on-chain in the standard ERC-8004 way.
 *
 * The agent list, the category (tag2) and the anchor all come from the shared
 * registry, so adding an agent is one edit in packages/shared/src/agents.ts.
 * Where a record has no proof yet, the anchor is harvested from the agent's own
 * JSONL log (see harvest-proofs.ts); --ref beats both.
 *
 * Usage:
 *   pnpm --filter @agripinaa/agents attest -- --dry-run
 *   pnpm --filter @agripinaa/agents attest -- --only lp-range
 *   pnpm --filter @agripinaa/agents attest -- --only lp-range --ref 7248592 --label pancake-v3-position
 *
 * --dir points the log harvest at a synced copy of the runner's data dir.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_LIST,
  BSC_MAINNET,
  ERC8004_REGISTRIES,
  bscScanTx,
  type AgentRecord,
} from '@agripinaa/shared';
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

import { feedbackAnchor, harvestAgentProofs } from './harvest-proofs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS = join(ROOT, '..', '..', 'wallets');
const OUT = join(ROOT, 'data', 'attestations.json');

const REP_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

/** Label used when --ref is passed without a --label to describe it. */
const DEFAULT_REF_LABEL = 'execution-proof';

/** The execution one attestation binds itself to, and where it came from. */
interface Anchor {
  label: string;
  ref: string;
  source: 'flag' | 'registry' | 'log';
}

function flag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/**
 * An explicit --ref wins, then the proof pinned on the registry record (which
 * is what the marketplace shows), then the newest proof harvested from the
 * agent's log. Null when the agent has executed nothing worth attesting to:
 * an attestation with no anchor would claim verification of nothing.
 */
export function anchorFor(
  record: AgentRecord,
  args: readonly string[],
  dir?: string,
): Anchor | null {
  const ref = flag(args, '--ref');
  if (ref) {
    return { label: flag(args, '--label') ?? DEFAULT_REF_LABEL, ref, source: 'flag' };
  }
  const pinned = record.proofs[0];
  if (pinned) return { label: pinned.label, ref: pinned.ref, source: 'registry' };
  const harvested = harvestAgentProofs(record.slug, dir)[0];
  if (harvested) return { label: harvested.summary, ref: harvested.ref, source: 'log' };
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = flag(args, '--only');
  const dirFlag = flag(args, '--dir');
  if (args.includes('--dir') && !dirFlag) {
    throw new Error('--dir needs a path to the synced data directory');
  }
  const dir = dirFlag ? resolve(dirFlag) : undefined;

  const registered = AGENT_LIST.filter(
    (record): record is AgentRecord & { tokenId: string } => record.tokenId !== null,
  );
  const selected = only
    ? registered.filter((record) => only.split(',').includes(record.slug))
    : registered;
  if (selected.length === 0) {
    throw new Error(
      `no registered agent matched${only ? ` --only ${only}` : ''}; an agent needs a tokenId in packages/shared/src/agents.ts before it can be attested`,
    );
  }
  // One ref describes one execution, so it must not be sprayed across agents.
  if (flag(args, '--ref') && selected.length > 1) {
    throw new Error('--ref attests to one specific execution; narrow the run with --only <slug>');
  }

  const registry = ERC8004_REGISTRIES[56]!.reputation;
  const records: Record<string, unknown> = existsSync(OUT)
    ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>)
    : {};

  if (dryRun) {
    console.log('dry run: nothing is signed and no wallet is loaded');
  }

  const verifier = dryRun ? null : loadVerifier();
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = verifier ? createPublicClient({ chain: bsc, transport }) : null;
  const walletClient = verifier
    ? createWalletClient({ account: verifier, chain: bsc, transport })
    : null;
  if (verifier) console.log(`verifier: ${verifier.address}`);

  for (const record of selected) {
    const agentId = record.tokenId;
    if (records[agentId]) {
      console.log(`${record.slug} (${agentId}): already attested, skipping`);
      continue;
    }
    const anchor = anchorFor(record, args, dir);
    if (!anchor) {
      console.log(`${record.slug} (${agentId}): no execution proof yet, skipping`);
      continue;
    }
    // feedbackHash binds this attestation to the specific execution proof.
    const feedbackHash = keccak256(toBytes(feedbackAnchor(anchor.label, anchor.ref)));
    const feedbackURI = `https://agripinaa.vercel.app/agent/56/${agentId}`;

    if (dryRun || !walletClient || !publicClient) {
      console.log(
        `${record.slug} (${agentId}): would attest tag2 ${record.category}, anchor ${feedbackAnchor(anchor.label, anchor.ref)} (${anchor.source}), feedbackHash ${feedbackHash}`,
      );
      continue;
    }

    console.log(`${record.slug} (${agentId}): attesting (${record.category}, ${anchor.label})...`);
    const hash = await walletClient.writeContract({
      address: registry,
      abi: REP_ABI,
      functionName: 'giveFeedback',
      args: [
        BigInt(agentId),
        BigInt(100), // value: verified/passing
        0, // valueDecimals
        'agripinaa-verified', // tag1 (indexed)
        record.category, // tag2
        'https://agripinaa.vercel.app', // endpoint
        feedbackURI,
        feedbackHash,
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${agentId}: attestation reverted (${hash})`);
    records[agentId] = {
      verifier: walletClient.account.address,
      txHash: hash,
      feedbackHash,
      proofLabel: anchor.label,
      proofRef: anchor.ref,
      tag1: 'agripinaa-verified',
      tag2: record.category,
      attestedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(records, null, 2));
    console.log(`${record.slug} (${agentId}): attested ${bscScanTx(56, hash)}`);
    // Writing this back into the registry record stays a deliberate edit.
    console.log(`  paste into packages/shared/src/agents.ts attestation: { txHash: '${hash}', verifier: '${walletClient.account.address}', tag: 'agripinaa-verified · ${record.category}', feedbackHash: '${feedbackHash}' }`);
  }
  console.log('done');
}

function loadVerifier() {
  const verifierFile = join(WALLETS, 'verifier.json');
  if (!existsSync(verifierFile)) {
    throw new Error(`missing ${verifierFile}; run: pnpm --filter @agripinaa/agents fund -- --gen (add "verifier")`);
  }
  const { privateKey } = JSON.parse(readFileSync(verifierFile, 'utf8')) as { privateKey: `0x${string}` };
  return privateKeyToAccount(privateKey);
}

// Only when invoked directly: importing this module must never sign anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
