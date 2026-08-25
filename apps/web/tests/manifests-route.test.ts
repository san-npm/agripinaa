import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newState, recordingFetch, withFetch } from './fetch-stub';

// A configured KV, so that any runnerBase() resolution would have to call it.
// Set before the route (and through it, the KV client) is imported, since the
// client reads its env at module load.
process.env.KV_REST_API_URL = 'https://kv.example.test';
process.env.KV_REST_API_TOKEN = 'kv-test-token';
delete process.env.AGENTS_BASE_URL;

test('an unknown manifest slug is a 404 before any KV command is spent', async () => {
  const { GET } = await import('../src/app/manifests/[slug]/route');
  const state = newState();
  const stub = recordingFetch(state, () => new Response('{"result":null}', { status: 200 }));
  for (const slug of ['random.json', 'nope', '..%2Fgrid.json']) {
    const res = await withFetch(stub, () =>
      GET(new Request(`https://agripinaa.test/manifests/${slug}`), { params: Promise.resolve({ slug }) }),
    );
    assert.equal(res.status, 404, slug);
  }
  assert.deepEqual(state.calls, [], 'the KV client was called for an unknown slug');
});
