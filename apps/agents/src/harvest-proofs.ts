/**
 * Turn the agents' own JSONL logs into execution proofs.
 *
 * Attesting an agent used to mean opening BscScan, finding the transaction
 * that shows the agent doing its job, and pasting the hash into attest.ts and
 * into the registry record by hand. The chassis already writes every execution
 * it performs to data/<slug>.log.jsonl, one JSON object per line, so the hashes
 * are on disk already: this module reads them back.
 *
 * The logs live on the runner VM (apps/agents/data is gitignored), so the CLI
 * takes an optional --dir pointing at a synced copy.
 *
 * Usage:
 *   pnpm --filter @agripinaa/agents harvest
 *   pnpm --filter @agripinaa/agents harvest -- --dir /path/to/synced/data
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_LIST } from '@agripinaa/shared';

import { parseFlags, type FlagSpec } from './cli-flags';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = join(ROOT, 'data');

/** How many proofs one agent may contribute; the newest ones win. */
const MAX_PER_AGENT = 5;

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** A PancakeSwap V3 position id: decimal, non-zero, within a plausible range. */
const POSITION_ID = /^[1-9][0-9]{0,19}$/;

/**
 * Event names whose suffix says the execution did NOT happen: the transaction
 * reverted (mint-reverted, decrease-liquidity-reverted), the action was
 * refused by a breaker or a guard (repair-skip, rebalance-blocked,
 * mint-skipped, exit-deferred), it threw (mint-failed, tick-error), it timed
 * out, or the object it names is not the agent's (position-ignored). Those
 * lines carry a hash or a token id like any other, so matching on the presence
 * of a reference alone would publish a failed transaction as proof of work.
 * Matching on the suffix rather than on an allowlist of good event names keeps
 * a newly added agent's events harvestable the day they are written.
 */
const NOT_AN_EXECUTION =
  /-(error|failed|failure|skip|skipped|blocked|deferred|ignored|reverted|timeout|unavailable|empty)$/;

export interface HarvestedProof {
  /** The agent that logged it, from the line's own `agent` field. */
  slug: string;
  kind: 'tx' | 'position';
  /** Transaction hash, or the token id of an NFT position. */
  ref: string;
  at: string;
  summary: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function txRef(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && TX_HASH.test(text) ? text : undefined;
}

function positionRef(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : stringValue(value);
  return text && POSITION_ID.test(text) ? text : undefined;
}

function validAt(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function proofFromEntry(entry: Record<string, unknown>, fallbackSlug: string): HarvestedProof | null {
  const event = stringValue(entry.event);
  const at = validAt(entry.at);
  if (!event || !at || NOT_AN_EXECUTION.test(event)) return null;

  // A line that carries both (lp-range's `minted`) is anchored to the
  // transaction: it is the stronger reference, and the position id is logged
  // again on every later range check.
  const tx = txRef(entry.txHash);
  const position = tx ? undefined : positionRef(entry.positionTokenId ?? entry.tokenId);
  const ref = tx ?? position;
  if (!ref) return null;

  return {
    slug: stringValue(entry.agent) ?? fallbackSlug,
    kind: tx ? 'tx' : 'position',
    ref,
    at,
    summary: stringValue(entry.summary) ?? event,
  };
}

/**
 * Read execution proofs out of raw JSONL lines: newest first, one entry per
 * distinct reference, at most `MAX_PER_AGENT` per agent. Never throws, since
 * a truncated last line is the normal state of a log the runner is still
 * writing to. `fallbackSlug` names the agent for lines written before the
 * chassis stamped `agent` onto every line.
 */
export function harvestProofs(lines: readonly string[], fallbackSlug = ''): HarvestedProof[] {
  const found: HarvestedProof[] = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partial write, or a stray console line in the file
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const proof = proofFromEntry(entry as Record<string, unknown>, fallbackSlug);
    if (proof) found.push(proof);
  }

  found.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const seen = new Set<string>();
  const perAgent = new Map<string, number>();
  return found.filter((proof) => {
    const key = `${proof.slug}:${proof.kind}:${proof.ref}`;
    if (seen.has(key)) return false;
    const count = perAgent.get(proof.slug) ?? 0;
    if (count >= MAX_PER_AGENT) return false;
    seen.add(key);
    perAgent.set(proof.slug, count + 1);
    return true;
  });
}

/** Where an agent's log lives, under the default data dir or a synced copy. */
export function agentLogPath(slug: string, dir: string = DEFAULT_DATA_DIR): string {
  return join(dir, `${slug}.log.jsonl`);
}

/** Proofs for one agent. An absent log is a normal outcome, and reads as none. */
export function harvestAgentProofs(slug: string, dir: string = DEFAULT_DATA_DIR): HarvestedProof[] {
  const file = agentLogPath(slug, dir);
  if (!existsSync(file)) return [];
  let contents = '';
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return harvestProofs(contents.split('\n').filter((line) => line.length > 0), slug);
}

/**
 * The exact string attest.ts hashes into an ERC-8004 feedbackHash. Kept here
 * so the harvest CLI can print the anchor the attestation will bind to.
 */
export function feedbackAnchor(label: string, ref: string): string {
  return `${label}:${ref}`;
}

const HARVEST_FLAGS: FlagSpec = { value: ['--dir'], boolean: [] };

function main(): void {
  const dirArg = parseFlags(process.argv.slice(2), HARVEST_FLAGS).value('--dir');
  const dir = dirArg ? resolve(dirArg) : DEFAULT_DATA_DIR;

  console.log(`reading logs from ${dir}`);
  for (const record of AGENT_LIST) {
    const file = agentLogPath(record.slug, dir);
    if (!existsSync(file)) {
      console.log(`\n${record.slug}: no log at ${file} (agent has not run here yet)`);
      continue;
    }
    const proofs = harvestAgentProofs(record.slug, dir);
    if (proofs.length === 0) {
      console.log(`\n${record.slug}: log present, no execution proof in it yet`);
      continue;
    }
    console.log(`\n${record.slug}: ${proofs.length} proof(s), newest first`);
    // Paste-ready ExecutionProof entries for the agent's record in
    // packages/shared/src/agents.ts. Labels come from the event name, so
    // rewrite them into the phrase a hirer should read before pasting.
    console.log('  proofs: [');
    for (const proof of proofs) {
      console.log(`    { label: '${proof.summary}', ref: '${proof.ref}', kind: '${proof.kind}', note: 'harvested from the ${proof.slug} log, ${proof.at}' },`);
    }
    console.log('  ],');
    const anchor = proofs[0]!;
    console.log(`  attestation anchor (newest): ${feedbackAnchor(anchor.summary, anchor.ref)}`);
    console.log(`  attest with: pnpm --filter @agripinaa/agents attest -- --only ${record.slug} --dry-run`);
  }
}

// Importing this module (attest.ts does) must not run the CLI.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
