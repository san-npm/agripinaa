import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';

import { createAgentkitClient } from '@worldcoin/agentkit';
import { privateKeyToAccount } from 'viem/accounts';

import {
  BoundedAgentKitStorage,
  agentkitChallenge,
  createAgentkitGate,
  resourceUriFor,
  trustedHost,
} from '../src/agentkit-gate';
import { RequestGate } from '../src/request-gate';
import { startX402Server } from '../src/x402-server';

const human = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const RESOURCE = 'https://abc-def.trycloudflare.com/grid/status';

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

const reason = (a: Awaited<ReturnType<ReturnType<typeof createAgentkitGate>['admit']>>) =>
  a.granted ? '' : a.reason;

test('only hosts this runner is published at get a resource URI, https unless local', () => {
  assert.equal(resourceUriFor({ headers: { host: 'abc.trycloudflare.com' } }, '/grid/status'), 'https://abc.trycloudflare.com/grid/status');
  assert.equal(resourceUriFor({ headers: { host: '127.0.0.1:4021' } }, '/grid/status'), 'http://127.0.0.1:4021/grid/status');
  // The listener binds every interface; a Host nobody published is not a domain to sign for.
  assert.equal(resourceUriFor({ headers: { host: 'attacker.example' } }, '/grid/status'), null);
  assert.equal(resourceUriFor({ headers: {} }, '/grid/status'), null);
  assert.equal(trustedHost('evil.trycloudflare.com.attacker.example'), false);
});

test('a human-backed wallet reads free for its trial, then pays like everyone else', async () => {
  const gate = createAgentkitGate({ agentBooks: [book], uses: 2 });
  const first = await gate.admit(await headerFor(human), RESOURCE, '/grid/status');
  assert.deepEqual(first, { granted: true, humanId: '0xhuman1', address: human.address, registry: 'test-book' });
  const second = await gate.admit(await headerFor(human), RESOURCE, '/grid/status');
  assert.equal(second.granted, true);
  const third = await gate.admit(await headerFor(human), RESOURCE, '/grid/status');
  assert.equal(third.granted, false);
  assert.match(reason(third), /free trial of 2 used up/);
  // The counter is per endpoint: another agent's status is a fresh trial.
  const yieldUri = 'https://abc-def.trycloudflare.com/yield/status';
  const other = await gate.admit(await headerFor(human, yieldUri), yieldUri, '/yield/status');
  assert.equal(other.granted, true);
});

test('a wallet nobody vouched for, a replayed header, and a header for another host are all refused', async () => {
  const gate = createAgentkitGate({ agentBooks: [book] });
  const unknown = await gate.admit(await headerFor(stranger), RESOURCE, '/grid/status');
  assert.equal(unknown.granted, false);
  assert.match(reason(unknown), /not registered in AgentBook/);

  const header = await headerFor(human);
  assert.equal((await gate.admit(header, RESOURCE, '/grid/status')).granted, true);
  const replay = await gate.admit(header, RESOURCE, '/grid/status');
  assert.equal(replay.granted, false);
  assert.match(reason(replay), /replay/i);

  const elsewhere = await gate.admit(await headerFor(human, 'https://other.example/grid/status'), RESOURCE, '/grid/status');
  assert.equal(elsewhere.granted, false);
  assert.match(reason(elsewhere), /Domain mismatch/);

  assert.deepEqual(await gate.admit(undefined, RESOURCE, '/grid/status'), { granted: false, reason: 'no agentkit header' });
  assert.match(reason(await gate.admit(header, null, '/grid/status')), /not a published runner host/);
  assert.equal((await gate.admit('not base64 json', RESOURCE, '/grid/status')).granted, false);
});

test('a signature for another path on the same host does not open this one', async () => {
  const gate = createAgentkitGate({ agentBooks: [book] });
  const login = 'https://abc-def.trycloudflare.com/login';
  const crossed = await gate.admit(await headerFor(human, login), RESOURCE, '/grid/status');
  assert.equal(crossed.granted, false);
  assert.match(reason(crossed), /URI mismatch: signed for .*\/login/);
});

test('one captured header admits at most once, however many arrive together', async () => {
  const gate = createAgentkitGate({ agentBooks: [book], uses: 10 });
  const header = await headerFor(human);
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () => gate.admit(header, RESOURCE, '/grid/status')),
  );
  assert.equal(outcomes.filter((o) => o.granted).length, 1);
  assert.equal(outcomes.filter((o) => !o.granted && /replay/i.test(o.reason)).length, 3);
});

test('a payload the library cannot format is declined, not thrown', async () => {
  const gate = createAgentkitGate({ agentBooks: [book] });
  const challenge = agentkitChallenge(RESOURCE).agentkit;
  const good = JSON.parse(Buffer.from(await signer(human).createHeader(challenge), 'base64').toString('utf8'));
  // A nonce that parses but that SIWE formatting rejects.
  const bad = Buffer.from(JSON.stringify({ ...good, nonce: 'x' }), 'utf8').toString('base64');
  const declined = await gate.admit(bad, RESOURCE, '/grid/status');
  assert.equal(declined.granted, false);
  assert.ok(reason(declined).length > 0);
});

test('the nonce store forgets expired nonces and never exceeds its cap', () => {
  const storage = new BoundedAgentKitStorage(1_000, 3);
  assert.equal(storage.reserveNonce('a', 0), true);
  assert.equal(storage.reserveNonce('a', 500), false, 'still fresh: replay');
  assert.equal(storage.reserveNonce('a', 2_000), true, 'expired: the nonce may be issued again');
  assert.equal(storage.reserveNonce('b', 2_000), true);
  assert.equal(storage.reserveNonce('c', 2_000), true);
  // Full of fresh nonces: the oldest goes, the store stays at the cap.
  assert.equal(storage.reserveNonce('d', 2_000), true);
  assert.equal(storage.reserveNonce('a', 2_000), true, "'a' was evicted, so it is fresh again");
});

test('verification is rate limited per client and in flight', async () => {
  const gate = createAgentkitGate({ agentBooks: [book], gate: new RequestGate(1, 60_000, 8) });
  const first = await gate.admit(await headerFor(human), RESOURCE, '/grid/status', '10.0.0.1');
  assert.equal(first.granted, true);
  const throttled = await gate.admit(await headerFor(human), RESOURCE, '/grid/status', '10.0.0.1');
  assert.equal(throttled.granted, false);
  assert.match(reason(throttled), /too many verification attempts/);
  const someoneElse = await gate.admit(await headerFor(human), RESOURCE, '/grid/status', '10.0.0.2');
  assert.equal(someoneElse.granted, true);
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

  // A Host nobody published gets the plain payment challenge and no
  // invitation. fetch() strips a caller-set Host, so this goes over node:http.
  const spoofed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: address.port, path: '/grid/status', headers: { host: 'attacker.example' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(spoofed.status, 402);
  const spoofedBody = JSON.parse(spoofed.body) as { extensions?: unknown };
  assert.equal(spoofedBody.extensions, undefined);

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
