/**
 * attest.ts signs mainnet ReputationRegistry transactions out of what these
 * flags resolve to, and an attestation cannot be taken back. A flag that is
 * mistyped, repeated or left without a value must stop the run here, before
 * anything is hashed or signed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFlags, type FlagSpec } from '../src/cli-flags';

const SPEC: FlagSpec = { value: ['--only', '--ref', '--label'], boolean: ['--dry-run'] };

test('reads values in both the spaced and the joined form', () => {
  const flags = parseFlags(['--only', 'lp-range', '--ref=7248592'], SPEC);
  assert.equal(flags.value('--only'), 'lp-range');
  assert.equal(flags.value('--ref'), '7248592');
});

test('an absent flag has no value and is not present', () => {
  const flags = parseFlags(['--dry-run'], SPEC);
  assert.equal(flags.value('--ref'), undefined);
  assert.equal(flags.has('--dry-run'), true);
  assert.equal(flags.has('--ref'), false);
});

test('a value flag left at the end of the line is refused', () => {
  assert.throws(() => parseFlags(['--only', 'lp-range', '--ref'], SPEC), /--ref needs a value/);
});

test('a value flag never swallows the flag that follows it', () => {
  // The reported case: --ref --label pancake would have signed
  // keccak256('pancake:--label') without this.
  assert.throws(
    () => parseFlags(['--only', 'lp-range', '--ref', '--label', 'pancake'], SPEC),
    /--ref needs a value/,
  );
});

test('an empty value is refused rather than read as no flag at all', () => {
  assert.throws(() => parseFlags(['--only='], SPEC), /--only needs a value/);
});

test('an unknown flag stops the run instead of being ignored', () => {
  assert.throws(() => parseFlags(['--dryrun'], SPEC), /unknown option --dryrun/);
});

test('a bare word stops the run: every input here is a flag', () => {
  assert.throws(() => parseFlags(['lp-range'], SPEC), /unexpected argument lp-range/);
});

test('a boolean flag takes no value', () => {
  assert.throws(() => parseFlags(['--dry-run=false'], SPEC), /--dry-run takes no value/);
});

test('a repeated flag is refused rather than silently keeping one of them', () => {
  assert.throws(() => parseFlags(['--ref', '0xaa', '--ref', '0xbb'], SPEC), /--ref given twice/);
  assert.throws(() => parseFlags(['--dry-run', '--dry-run'], SPEC), /--dry-run given twice/);
});
