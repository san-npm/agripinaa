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
 * --dir points the log harvest at a synced copy of the runner's data dir. A
 * flag it cannot read (no value, unknown name, repeated) stops the run: nothing
 * is signed out of a half-read command line.
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

import { parseFlags, type FlagSpec, type Flags } from './cli-flags';
import { ORDER_UID, POSITION_ID, TX_HASH, feedbackAnchor, harvestAgentProofs } from './harvest-proofs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS = join(ROOT, '..', '..', 'wallets');
const OUT = join(ROOT, 'data', 'attestations.json');

const REP_ABI = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

/** Label used when --ref is passed without a --label to describe it. */
const DEFAULT_REF_LABEL = 'execution-proof';

/**
 * An attestation is unfixable once signed, so a --ref that is not shaped like
 * any real execution reference must stop the run before feedbackHash is ever
 * computed. Called from main() before the per-record loop, so a malformed
 * --ref refuses even when every --only'd agent already has an attestation on
 * disk (main()'s "already attested, skipping" branch would otherwise return
 * before anchorFor() ever runs this same check) and again from anchorFor()
 * so a caller that reaches it directly, as the anchor precedence tests do,
 * gets the identical guard.
 */
function assertRecognizedRef(ref: string): void {
  if (!TX_HASH.test(ref) && !ORDER_UID.test(ref) && !POSITION_ID.test(ref)) {
    throw new Error(
      `--ref ${ref} is not a recognized execution reference; pass a 64-hex tx hash, a 112-hex Ophis order uid, or a decimal position id`,
    );
  }
}

/** The execution one attestation binds itself to, and where it came from. */
interface Anchor {
  label: string;
  ref: string;
  source: 'flag' | 'registry' | 'log';
}

/**
 * The whole command line. Exported so the anchor test parses exactly what
 * main() parses; a flag with no value stops the run in parseFlags.
 */
export const ATTEST_FLAGS: FlagSpec = {
  value: ['--only', '--ref', '--label', '--dir'],
  boolean: ['--dry-run'],
};

/**
 * An explicit --ref wins, then the proof pinned on the registry record (which
 * is what the marketplace shows), then the newest proof harvested from the
 * agent's log. Null when the agent has executed nothing worth attesting to:
 * an attestation with no anchor would claim verification of nothing.
 */
export function anchorFor(record: AgentRecord, flags: Flags, dir?: string): Anchor | null {
  const ref = flags.value('--ref');
  if (ref) {
    assertRecognizedRef(ref);
    return { label: flags.value('--label') ?? DEFAULT_REF_LABEL, ref, source: 'flag' };
  }
  const pinned = record.proofs[0];
  if (pinned) return { label: pinned.label, ref: pinned.ref, source: 'registry' };
  const harvested = harvestAgentProofs(record.slug, dir)[0];
  if (harvested) return { label: harvested.summary, ref: harvested.ref, source: 'log' };
  return null;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), ATTEST_FLAGS);
  const dryRun = flags.has('--dry-run');
  const only = flags.value('--only');
  const dirFlag = flags.value('--dir');
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
  if (flags.has('--ref') && selected.length > 1) {
    throw new Error('--ref attests to one specific execution; narrow the run with --only <slug>');
  }
  // Checked here, ahead of the per-record loop below, so a malformed --ref
  // refuses even when the selected agent(s) are already attested and the
  // loop would otherwise skip past anchorFor() (where this same shape check
  // also lives) without ever calling it.
  const refFlag = flags.value('--ref');
  if (refFlag) assertRecognizedRef(refFlag);

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
    const anchor = anchorFor(record, flags, dir);
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

    // The same line the dry run prints, so what gets signed is on screen first.
    console.log(
      `${record.slug} (${agentId}): attesting tag2 ${record.category}, anchor ${feedbackAnchor(anchor.label, anchor.ref)} (${anchor.source}), feedbackHash ${feedbackHash}...`,
    );
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
