import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchManagerKey, validateManagerKey } from '../src/lib/manager-key';

import { newState, recordingFetch, withFetch } from './fetch-stub';

/**
 * What the live runner reported for the Harvester on 2026-08-25 (public data:
 * the SEC1 point and its address). The address is the value pinned in the
 * shared registry, so this is the only pair the browser may accept for it.
 */
const LIVE_YIELD_USDT = {
  publicKey:
    '0x04fad48fa6dbb1f7cd395adad04c7ef215e2d0ccc3528159815e48f3ac99760ef347f14efc13852039768534b526b9addd573cf6bc8ad896cacf7105fc628143a7' as Hex,
  address: '0x94Fb3dD927a7Bc17cEc1C6D8281A861Ffe76D8B6' as Hex,
};

/** A synthetic key pair that is well-formed but belongs to nobody we trust. */
const stranger = privateKeyToAccount(keccak256(stringToHex('agripinaa manager-key web test vector')));

function jsonFetch(status: number, body: unknown) {
  return recordingFetch(newState(), () => new Response(JSON.stringify(body), { status }));
}

/** Silence and capture the missing-pin warning so test output stays clean. */
async function capturingWarn<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

test('the pinned Harvester key is accepted', () => {
  const info = validateManagerKey('yield', 'USDT', { agent: 'yield', ...LIVE_YIELD_USDT });
  assert.deepEqual(info, { agent: 'yield', ...LIVE_YIELD_USDT });
});

test('a well-formed key that is not the pinned one is refused (mocked runner)', async () => {
  // A re-issued tunnel name answering with its own key: valid shape, valid
  // pair, wrong identity. This is the trust boundary the pin exists for.
  const stub = jsonFetch(200, { agent: 'yield', publicKey: stranger.publicKey, address: stranger.address });
  await withFetch(stub, () =>
    assert.rejects(() => fetchManagerKey('yield', 'USDT'), /does not match the pinned manager key/),
  );
});

test('the pinned address with a foreign public key is refused', () => {
  // The grant is made to the public key, so an attacker who knows the pinned
  // address could pair it with their own point; the address must derive from
  // the point it is reported with.
  assert.throws(
    () => validateManagerKey('yield', 'USDT', { publicKey: stranger.publicKey, address: LIVE_YIELD_USDT.address }),
    /does not belong to the public key/,
  );
});

test('malformed fields are refused before any pin check', () => {
  const good = { publicKey: stranger.publicKey, address: stranger.address };
  for (const bad of [
    { ...good, address: 'not-an-address' },
    { ...good, address: '0x94fb3dd927a7bc17cec1c6d8281a861ffe76d8b' }, // 39 hex chars
    { ...good, publicKey: stranger.publicKey.slice(0, -2) }, // 64 bytes
    { ...good, publicKey: `0x03${stranger.publicKey.slice(4)}` }, // compressed prefix
    { publicKey: stranger.publicKey }, // no address
    { address: stranger.address }, // no public key
    null,
    'string',
  ]) {
    assert.throws(() => validateManagerKey('yield-b', 'USDT', bad), /manager key rejected/, JSON.stringify(bad));
  }
});

test('an agent with no pin yet is accepted with a logged warning', async () => {
  const stub = jsonFetch(200, { agent: 'yield-b', publicKey: stranger.publicKey, address: stranger.address });
  const { result, warnings } = await capturingWarn(() => withFetch(stub, () => fetchManagerKey('yield-b', 'USDT')));
  assert.equal(result.address, stranger.address);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /yield-b/);
});

test('a runner error keeps its message and status', async () => {
  const stub = jsonFetch(404, { error: 'agent does not support managed mode' });
  await withFetch(stub, () =>
    assert.rejects(() => fetchManagerKey('grid', 'USDT'), /agent does not support managed mode/),
  );
});
