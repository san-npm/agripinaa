/**
 * anchorFor() validates --ref, but so does main() before it: main() skips a
 * selected agent that already carries an attestation in data/attestations.json
 * before it ever calls anchorFor(), so a shape check that lived only inside
 * anchorFor() would let a malformed --ref sail through for any agent already
 * attested. These tests spawn the real CLI (not just the exported function)
 * so that regression stays caught regardless of which validation path it was
 * fixed in. Every run here is --dry-run: nothing is signed, no wallet is
 * loaded, and data/attestations.json is only ever read, never written.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const AGENTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_BIN = join(AGENTS_ROOT, 'node_modules', '.bin', 'tsx');

function runAttest(args: readonly string[]) {
  return spawnSync(TSX_BIN, ['src/attest.ts', ...args], {
    cwd: AGENTS_ROOT,
    encoding: 'utf8',
  });
}

test('a malformed --ref refuses before the per-record loop can skip past it, exactly as the brief specifies', () => {
  // The brief's own Step 3 acceptance command, run against the real CLI.
  const result = runAttest(['--dry-run', '--only', 'grid', '--ref', '0xdead']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--ref 0xdead is not a recognized execution reference/);
  // Whether or not grid already carries a real attestation on this machine,
  // neither of main()'s per-record lines may appear: the refusal must land
  // before the loop starts, not inside it.
  assert.doesNotMatch(result.stdout, /already attested/);
  assert.doesNotMatch(result.stdout, /would attest/);
});

test('an unflagged run still resolves an anchor for grid, whether that is the registry proof or a prior attestation', () => {
  const result = runAttest(['--dry-run', '--only', 'grid']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /grid \(269703\): (would attest|already attested, skipping)/);
  assert.match(result.stdout, /\bdone\b/);
});
