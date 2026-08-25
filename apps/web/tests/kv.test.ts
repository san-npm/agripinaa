import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withFetch } from './fetch-stub';

// kv.ts reads its credentials once, at import time, so the env has to be in
// place before the module is loaded. Node's test runner gives each file its own
// process, so this does not leak into any other test.
process.env.KV_REST_API_URL = 'https://kv.example.com';
process.env.KV_REST_API_TOKEN = 'test-kv-token';

/**
 * Loaded lazily (the web tests transform to CJS, where a top level await is not
 * available) and after the env is in place. The module cache keeps this to one
 * real load.
 */
const loadKv = () => import('../src/lib/kv');

interface Sent {
  url: string;
  command: unknown[];
}

/** Records each REST command and answers with whatever `respond` returns. */
function restStub(sent: Sent[], respond: (command: unknown[]) => Response): typeof fetch {
  return async (input, init) => {
    const command = JSON.parse(String(init?.body ?? '[]')) as unknown[];
    sent.push({ url: String(input), command });
    return respond(command);
  };
}

const answering =
  (values: (string | null)[]) =>
  (): Response =>
    Response.json({ result: values });

test('the stubbed credentials make kv available', async () => {
  const { kvAvailable } = await loadKv();
  assert.equal(kvAvailable(), true);
});

test('mget answers one value per key, in order, with nulls for misses', async () => {
  const { kvMGet } = await loadKv();
  const sent: Sent[] = [];
  const values = await withFetch(restStub(sent, answering(['{"a":1}', null, '{"c":3}'])), () =>
    kvMGet(['a', 'b', 'c']),
  );
  assert.deepEqual(values, ['{"a":1}', null, '{"c":3}']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.command, ['MGET', 'a', 'b', 'c']);
});

test('a long key list goes out in batches and comes back whole', async () => {
  const { kvMGet } = await loadKv();
  const sent: Sent[] = [];
  const keys = Array.from({ length: 250 }, (_, i) => `agripinaa:claim:56:${i}`);
  const values = await withFetch(
    restStub(sent, (command) => Response.json({ result: command.slice(1).map((k) => `v:${String(k)}`) })),
    () => kvMGet(keys),
  );
  assert.equal(values.length, 250);
  assert.equal(values[0], 'v:agripinaa:claim:56:0');
  assert.equal(values[249], 'v:agripinaa:claim:56:249');
  assert.deepEqual(
    sent.map((s) => s.command.length - 1),
    [100, 100, 50],
  );
});

test('a failed batch reads as misses rather than throwing', async () => {
  const { kvMGet } = await loadKv();
  const sent: Sent[] = [];
  const values = await withFetch(
    restStub(sent, () => new Response('nope', { status: 500 })),
    () => kvMGet(['a', 'b']),
  );
  assert.deepEqual(values, [null, null]);
});

test('a short answer from upstream still lines up with the keys asked for', async () => {
  const { kvMGet } = await loadKv();
  const sent: Sent[] = [];
  const values = await withFetch(restStub(sent, answering(['only-one'])), () =>
    kvMGet(['a', 'b', 'c']),
  );
  assert.deepEqual(values, ['only-one', null, null]);
});

test('an empty key list costs no request', async () => {
  const { kvMGet } = await loadKv();
  const sent: Sent[] = [];
  const values = await withFetch(restStub(sent, answering([])), () => kvMGet([]));
  assert.deepEqual(values, []);
  assert.equal(sent.length, 0);
});
