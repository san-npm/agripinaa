import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendLogLine, ensureDataDir, loadAgentAccount, writeStateFile } from '../src/chassis';

/**
 * State and log files sit beside the wallets on the VM, which are 0600. They
 * were written at the default umask, so a halt flag or a rate-limit ledger
 * ended up world-readable while the key next to it was not. POSIX modes only:
 * Windows has no equivalent bits to assert.
 */
const posix = process.platform !== 'win32';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'agripinaa-chassis-'));
}

test('a missing agent wallet prints a strict funding selector that exists', () => {
  assert.throws(
    () => loadAgentAccount('not-a-real-agent-recovery-test'),
    /--gen --only agent-not-a-real-agent-recovery-test/,
  );
});

test('the data dir is created owner-only', { skip: !posix }, () => {
  const root = scratch();
  try {
    const dir = join(root, 'data');
    ensureDataDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    ensureDataDir(dir); // idempotent on an existing dir
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a data dir that already exists at a wider mode is tightened to 0700', { skip: !posix }, () => {
  // mkdirSync applies its mode only when it creates the dir. On the VM the dir
  // predates the mode (the run lock created it at the default umask before the
  // chassis wrote anything), so creating with 0700 alone left it as it was.
  const root = scratch();
  try {
    const dir = join(root, 'data');
    mkdirSync(dir, { mode: 0o755 });
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    ensureDataDir(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a state file lands at 0600 through the atomic temp+rename path', { skip: !posix }, () => {
  const root = scratch();
  try {
    const file = join(root, 'grid.state.json');
    writeStateFile(file, '{"halted":null}');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), '{"halted":null}');
    assert.throws(() => statSync(`${file}.tmp`), 'the temp file was not renamed away');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a leftover temp file from a crash does not carry its wider mode into the state file', { skip: !posix }, () => {
  // writeFileSync's mode applies only when it creates the file; a crash mid-
  // write leaves a temp file behind at whatever mode it had, and the next
  // write reuses that path.
  const root = scratch();
  try {
    const file = join(root, 'yield.state.json');
    writeFileSync(`${file}.tmp`, 'stale', { mode: 0o644 });
    writeStateFile(file, '{"actions":{}}');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), '{"actions":{}}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a log file that predates the mode is tightened to 0600 on the first append', { skip: !posix }, () => {
  // appendFileSync's mode applies only when it creates the file. On the VM the
  // logs already exist at the default umask, so the first append of a process
  // chmods the file it is about to extend.
  const root = scratch();
  try {
    const file = join(root, 'yield.log.jsonl');
    writeFileSync(file, '{"event":"boot"}\n', { mode: 0o644 });
    assert.equal(statSync(file).mode & 0o777, 0o644);
    appendLogLine(file, '{"event":"tick"}');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), '{"event":"boot"}\n{"event":"tick"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a log file is created at 0600 and appended to', { skip: !posix }, () => {
  const root = scratch();
  try {
    const file = join(root, 'grid.log.jsonl');
    appendLogLine(file, '{"event":"boot"}');
    appendLogLine(file, '{"event":"tick"}');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), '{"event":"boot"}\n{"event":"tick"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
