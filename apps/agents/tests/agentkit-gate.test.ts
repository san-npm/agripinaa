import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createAgentkitClient } from '@worldcoin/agentkit';
import { privateKeyToAccount } from 'viem/accounts';

import { agentkitChallenge, createAgentkitGate, resourceUriFor } from '../src/agentkit-gate';
import { startX402Server } from '../src/x402-server';

const human = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const RESOURCE = 'https://runner.example/grid/status';

/** An AgentBook where exactly one wallet was vouched for. */
const book = {
  name: 'test-book',
  verifier: {
    lookupHuman: async (address: string) =>
      address.toLowerCase() === human.address.toLowerCase() ? '0xhuman1' : null,
  },
};

function signer(account: typeof human) {
  return createAgentkitClient({
    signer: {
      address: account.address,
      chainId: 'eip155:56',
      type: 'eip191',
      signMessage: (message) => account.signMessage({ message }),
    },
  });
}

/** What an AgentKit client does with the 402: sign the challenge it carries. */
async function headerFor(account: typeof human, resourceUri = RESOURCE) {
  const challenge = agentkitChallenge(resourceUri).agentkit;
  return signer(account).createHeader(challenge);
}

test('the resource URI is the public one the tunnel exposes, http only for local hosts', () => {
  assert.equal(resourceUriFor({ headers: { host: 'abc.trycloudflare.com' } }, '/grid/status'), 'https://abc.trycloudflare.com/grid/status');
  assert.equal(resourceUriFor({ headers: { host: '127.0.0.1:4021' } }, '/grid/status'), 'http://127.0.0.1:4021/grid/status');
});

test('a human-backed wallet reads free for its trial, then pays like everyone else', async () => {
  const gate = createAgentkitGate({ agentBooks: [book], uses: 2 });
  const first = await gate.admit(await headerFor(human), RESOURCE, '/grid/status');
  assert.deepEqual(first, { granted: true, humanId: '0xhuman1', address: human.address, registry: 'test-book' });
  const second = await gate.admit(await headerFor(human), RESOURCE, '/grid/status');
  assert.equal(second.granted, true);
  const third = await gate.admit(await headerFor(human), RESOURCE, '/grid/status');
  assert.equal(third.granted, false);
  assert.match((third as { reason: string }).reason, /free trial of 2 used up/);
  // The counter is per endpoint: another agent's status is a fresh trial.
  const other = await gate.admit(await headerFor(human, 'https://runner.example/yield/status'), 'https://runner.example/yield/status', '/yield/status');
  assert.equal(other.granted, true);
});

test('a wallet nobody vouched for, a replayed header, and a header for another host are all refused', async () => {
  const gate = createAgentkitGate({ agentBooks: [book] });
  const unknown = await gate.admit(await headerFor(stranger), RESOURCE, '/grid/status');
  assert.equal(unknown.granted, false);
  assert.match((unknown as { reason: string }).reason, /not registered in AgentBook/);

  const header = await headerFor(human);
  assert.equal((await gate.admit(header, RESOURCE, '/grid/status')).granted, true);
  const replay = await gate.admit(header, RESOURCE, '/grid/status');
  assert.equal(replay.granted, false);
  assert.match((replay as { reason: string }).reason, /replay/i);

  const elsewhere = await gate.admit(await headerFor(human, 'https://other.example/grid/status'), RESOURCE, '/grid/status');
  assert.equal(elsewhere.granted, false);
  assert.match((elsewhere as { reason: string }).reason, /Domain mismatch/);

  assert.deepEqual(await gate.admit(undefined, RESOURCE, '/grid/status'), { granted: false, reason: 'no agentkit header' });
  assert.equal((await gate.admit('not base64 json', RESOURCE, '/grid/status')).granted, false);
});

test('the status route offers the challenge in its 402 and serves a human-backed caller without settlement', async (t) => {
  const logged: Record<string, unknown>[] = [];
  const entry = {
    module: { name: 'grid', category: 'grid', tickIntervalMs: 1, tick: async () => {}, status: async () => ({ ok: true }) },
    ctx: { account: { address: human.address }, log: (row: Record<string, unknown>) => logged.push(row) },
  };
  const server = startX402Server({
    port: 0,
    facilitatorKey: `0x${'33'.repeat(32)}`,
    agents: new Map([['grid', entry]]) as unknown as Parameters<typeof startX402Server>[0]['agents'],
    agentkit: createAgentkitGate({ agentBooks: [book] }),
  });
  t.after(() => server.close());
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/grid/status`;

  const challenged = await fetch(url);
  assert.equal(challenged.status, 402);
  const body = (await challenged.json()) as { accepts: unknown[]; extensions: { agentkit: { info: { uri: string; nonce: string }; mode: unknown } }; agentkit?: unknown };
  assert.ok(Array.isArray(body.accepts), 'the payment challenge is untouched');
  assert.equal(body.extensions.agentkit.info.uri, url);
  assert.equal(typeof body.extensions.agentkit.info.nonce, 'string');
  assert.deepEqual(body.extensions.agentkit.mode, { type: 'free-trial', uses: 3 });
  assert.equal(body.agentkit, undefined, 'no header, so nothing to decline');

  // The AgentKit client retries the 402 with the signed challenge on its own.
  const served = await signer(human).fetch(url);
  assert.equal(served.status, 200);
  const payload = (await served.json()) as Record<string, unknown>;
  assert.equal(payload['paidBy'], null);
  assert.deepEqual(payload['agentkit'], { humanBacked: true, humanId: '0xhuman1', registry: 'test-book', freeTrial: true });
  assert.deepEqual(payload['status'], { ok: true });
  assert.equal(logged[0]?.['event'], 'status-free-trial');

  const refused = await signer(stranger).fetch(url);
  assert.equal(refused.status, 402);
  const why = (await refused.json()) as { agentkit: { declined: string } };
  assert.match(why.agentkit.declined, /not registered in AgentBook/);
});
