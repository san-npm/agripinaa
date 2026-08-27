/**
 * The anchor is what a ReputationRegistry attestation binds itself to, through
 * its feedbackHash. Getting the precedence wrong means attesting to the wrong
 * execution, which is unfixable once signed, so pin the order here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { agentBySlug } from '@agripinaa/shared';

import { ATTEST_FLAGS, anchorFor } from '../src/attest';
import { parseFlags } from '../src/cli-flags';

const registered = agentBySlug('lp-range')!;
const newlyRegistered = agentBySlug('grid-b')!;

/** The same parse main() runs, so a test can never hand anchorFor raw argv. */
function flags(args: readonly string[]) {
  return parseFlags(args, ATTEST_FLAGS);
}

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agripinaa-harvest-'));
  scratch.push(dir);
  return dir;
}

function logDir(slug: string, lines: Record<string, unknown>[]): string {
  const dir = emptyDir();
  writeFileSync(join(dir, `${slug}.log.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return dir;
}

test('an explicit ref beats the registry proof and the log', () => {
  const dir = logDir('lp-range', [
    { agent: 'lp-range', event: 'range-check', at: '2026-08-24T10:00:00.000Z', tokenId: '7248592' },
  ]);
  const anchor = anchorFor(registered, flags(['--ref', '7311111', '--label', 'pancake-v3-position']), dir);
  assert.deepEqual(anchor, { label: 'pancake-v3-position', ref: '7311111', source: 'flag' });
});

test('the registry proof is the anchor when no ref is passed', () => {
  const dir = logDir('lp-range', [
    { agent: 'lp-range', event: 'range-check', at: '2026-08-24T10:00:00.000Z', tokenId: '7248592' },
  ]);
  const anchor = anchorFor(registered, flags([]), dir);
  assert.equal(anchor!.source, 'registry');
  assert.equal(anchor!.ref, registered.proofs[0]!.ref);
});

test('an agent with no pinned proof falls back to its newest logged execution', () => {
  const dir = logDir('grid-b', [
    { agent: 'grid-b', event: 'repay', at: '2026-08-24T10:00:00.000Z', txHash: '0x' + 'a'.repeat(64) },
    { agent: 'grid-b', event: 'supply', at: '2026-08-24T12:00:00.000Z', txHash: '0x' + 'b'.repeat(64) },
  ]);
  assert.deepEqual(newlyRegistered.proofs, []);
  const anchor = anchorFor(newlyRegistered, flags([]), dir);
  assert.deepEqual(anchor, { label: 'supply', ref: '0x' + 'b'.repeat(64), source: 'log' });
});

test('no proof anywhere yields no anchor, so nothing can be attested blind', () => {
  assert.equal(anchorFor(newlyRegistered, flags([]), emptyDir()), null);
});

test('a value-less --ref stops the run instead of anchoring to a stale proof', () => {
  // Without the parse it read the next flag as the ref, or fell through to the
  // registry proof: both sign an attestation the operator did not ask for.
  assert.throws(() => flags(['--only', 'lp-range', '--ref', '--label', 'pancake']), /--ref needs a value/);
  assert.throws(() => flags(['--only', 'lp-range', '--ref']), /--ref needs a value/);
});

test('a value-less --only stops the run instead of selecting every agent', () => {
  assert.throws(() => flags(['--only', '--dry-run']), /--only needs a value/);
});

test('a --ref shaped like nothing real refuses before anything is hashed', () => {
  assert.throws(
    () => anchorFor(registered, flags(['--only', 'lp-range', '--ref', '0xdead']), emptyDir()),
    /not a recognized execution reference/,
  );
});

test('a --ref shaped like an Ophis order uid is accepted', () => {
  const uid = '0x' + 'c'.repeat(112);
  const anchor = anchorFor(registered, flags(['--only', 'grid', '--ref', uid]), emptyDir());
  assert.deepEqual(anchor, { label: 'execution-proof', ref: uid, source: 'flag' });
});
