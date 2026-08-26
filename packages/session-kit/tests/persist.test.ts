import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deserializeSession,
  loadSessionFile,
  roundTripIsExact,
  saveSessionFile,
  serializeSession,
} from '../src/index';

// Same shape as wallets/spike-b-session.json (keys redacted, values fake).
const sessionFixture = {
  walletAddress: '0xACF6FC404F2B2D11D77Fe788f1eDaE5A7E0996Cf',
  signer: {
    type: 'privateKey',
    address: '0x59cb56a0a8B09223256A5ED92FEAd4f726610c0F',
    publicKey: '0x04ab',
    _privateKey: '0x01',
  },
  publicKey: '0x04ab',
  permissions: {
    calls: [{ to: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' }],
    spend: [{ limit: 5000000000000000000n, period: 'day' }],
  },
  expiry: 1787074935,
};

test('bigints serialize with the marker and revive back to bigint', () => {
  const raw = serializeSession(sessionFixture);
  assert.ok(raw.includes('"bigint:5000000000000000000"'));
  const revived = deserializeSession(raw) as typeof sessionFixture;
  assert.equal(revived.permissions.spend[0]?.limit, 5000000000000000000n);
  assert.equal(typeof revived.permissions.spend[0]?.limit, 'bigint');
});

test('round trip is byte-exact for nested objects with bigints', () => {
  const first = serializeSession(sessionFixture);
  const second = serializeSession(deserializeSession(first));
  assert.equal(second, first);
  assert.equal(roundTripIsExact(sessionFixture), true);
});

test('round trip is byte-exact for deeply nested mixed values', () => {
  const gnarly = {
    a: [1n, 'two', { three: 3n, four: [4, '5', 6n] }],
    b: { c: { d: 0n, e: null, f: false } },
    g: 'bigint:123',
  };
  assert.equal(roundTripIsExact(gnarly), true);
});

test('deserializeSession(garbage) throws cleanly', () => {
  assert.throws(() => deserializeSession('not json at all'));
  assert.throws(() => deserializeSession('{"x": "bigint:notanumber"}'));
});

test('saveSessionFile writes the exact serializeSession bytes; loadSessionFile revives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-kit-'));
  try {
    const path = join(dir, 'session.json');
    await saveSessionFile(path, sessionFixture);
    const onDisk = await readFile(path, 'utf8');
    assert.equal(onDisk, serializeSession(sessionFixture));
    const loaded = (await loadSessionFile(path)) as typeof sessionFixture;
    assert.equal(loaded.permissions.spend[0]?.limit, 5000000000000000000n);
    assert.equal(serializeSession(loaded), onDisk);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      await writeFile(path, 'stale', { mode: 0o644 });
      await saveSessionFile(path, sessionFixture);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-serializing the real spike session file reproduces its exact bytes', async (t) => {
  const spikePath = '/Users/hodlmedia/agripinaa/wallets/spike-b-session.json';
  let onDisk: string;
  try {
    onDisk = await readFile(spikePath, 'utf8');
  } catch {
    t.skip('spike session file not present');
    return;
  }
  assert.equal(serializeSession(deserializeSession(onDisk)), onDisk);
});
