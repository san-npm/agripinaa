import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentBySlug } from '@agripinaa/shared/agents';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchManagerKey, validateManagerKey } from '../src/lib/manager-key';

import { newState, recordingFetch, withFetch } from './fetch-stub';

/**
 * What the live runner reports for the rotated Harvester key (public data:
 * the SEC1 point and its address). The address is the value pinned in the
 * shared registry, so this is the only pair the browser may accept for it.
 */
const LIVE_YIELD_USDT = {
  publicKey:
    '0x04dd62b1a4cbdcf5ccc794a295997afa130ccbe04b0cc4b9ee47bb2f4da965c0e8cade76fb13b4adc981ad580825b36e1449b4a8e43c105cccbea9fb29467869fc' as Hex,
  address: '0x085f9F61ff6d65a3632Fe0a4443a33d1E10341a2' as Hex,
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

test('an agent that is not registered on chain is accepted with a logged warning', async () => {
  // The Steward is configured and not yet minted (tokenId null), so no visitor
  // can reach an activate page for it and nothing can be granted to the key it
  // reports. That is the only slug the warn-and-accept path is left open for.
  const stub = jsonFetch(200, { agent: 'yield-b', publicKey: stranger.publicKey, address: stranger.address });
  const { result, warnings } = await capturingWarn(() => withFetch(stub, () => fetchManagerKey('yield-b', 'USDT')));
  assert.equal(agentBySlug('yield-b')?.tokenId, null, 'the fixture is the unregistered case');
  assert.equal(result.address, stranger.address);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /yield-b/);
});

test('a registered agent with no pin for the token is refused, not warned about', async () => {
  // The fail-open this closes: an agent a visitor CAN reach an activate page
  // for, reporting whatever key it likes, becoming the grantee of a live
  // mandate because the registry happened to hold no pin for it. A registered
  // agent has to be pinned before anything it reports can be granted to.
  for (const [agent, token] of [
    ['grid', 'USDT'],
    ['yield', 'USDX'],
  ] as const) {
    assert.notEqual(agentBySlug(agent)?.tokenId, null, `${agent} is registered`);
    assert.throws(
      () => validateManagerKey(agent, token, { publicKey: stranger.publicKey, address: stranger.address }),
      /manager key rejected: .* is registered on chain with no pinned/,
      `${agent}/${token}`,
    );
  }
  const stub = jsonFetch(200, { agent: 'grid', publicKey: stranger.publicKey, address: stranger.address });
  const { warnings } = await capturingWarn(() =>
    withFetch(stub, () => assert.rejects(() => fetchManagerKey('grid', 'USDT'), /no pinned/)),
  );
  assert.deepEqual(warnings, [], 'a refusal is not a warning');
});

test('a runner error keeps its message and status', async () => {
  const stub = jsonFetch(404, { error: 'agent does not support managed mode' });
  await withFetch(stub, () =>
    assert.rejects(() => fetchManagerKey('grid', 'USDT'), /agent does not support managed mode/),
  );
});
