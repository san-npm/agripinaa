/**
 * register.ts mints permanent ERC-8004 identities on BSC mainnet, so what these
 * tests hold is the part that decides WHETHER to sign at all.
 *
 * A second mint for an agent that already has one is not a wasted transaction:
 * it is a second identity, with its own token id, its own attestations and its
 * own profile page, while every manifest and every proof-feed row still points
 * at the first. It cannot be undone. Idempotency used to rest on
 * data/registry.json alone, which is gitignored and therefore exists only on
 * the machine that ran the original registration, so a fresh checkout (or the
 * VM) would have re-minted the four live agents.
 *
 * Nothing here touches the chain: the flag parsing and the plan are pure, and
 * the one chain read is exercised through a stub.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST, type AgentRecord } from '@agripinaa/shared';

import { parseFlags } from '../src/cli-flags';
import {
  REGISTER_FLAGS,
  alreadyRegistered,
  assertNoIdentityYet,
  pendingRegistrations,
  selectRecords,
  type RegistryLedger,
} from '../src/register';

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
const WALLET = '0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A' as const;
const only = (argv: string[]) => parseFlags(argv, REGISTER_FLAGS).value('--only');

/** A record the way it looks before registration: no id, no tx. */
const unregistered = AGENT_LIST.find((record) => record.tokenId === null);
/** A record the way it looks after: the four live agents are in this shape. */
const registered = AGENT_LIST.find((record) => record.tokenId !== null);

/* --------------------------------- flags --------------------------------- */

test('--only with no value stops the run rather than selecting every agent', () => {
  // The old indexOf scan read the next argv slot, so a trailing --only meant
  // "all of them" on a command that mints.
  assert.throws(() => only(['--only']), /needs a value/);
  assert.throws(() => parseFlags(['--only', '--dry-run'], REGISTER_FLAGS), /needs a value/);
});

test('--only with a slug that does not exist stops the run', () => {
  assert.throws(() => selectRecords(AGENT_LIST, 'grid-c'), /unknown agent slug\(s\) grid-c/);
  assert.throws(() => selectRecords(AGENT_LIST, ''), /at least one agent slug/);
});

test('--only selects exactly the named agents', () => {
  const selected = selectRecords(AGENT_LIST, only(['--only', 'grid-b,yield-b']));
  assert.deepEqual(selected.map((record) => record.slug), ['grid-b', 'yield-b']);
  assert.equal(selectRecords(AGENT_LIST, undefined).length, AGENT_LIST.length);
});

/* ------------------------------ idempotency ------------------------------ */

test('a record that carries a token id is never minted again, ledger or no ledger', () => {
  assert.ok(registered, 'the registry has no registered agent to check');
  // The fresh-checkout case exactly: no data/registry.json anywhere.
  assert.match(alreadyRegistered(registered, {}) ?? '', /tokenId/);
  assert.deepEqual(pendingRegistrations([registered], {}), []);
});

test('a registration tx with no token id yet also counts as registered', () => {
  // The window between the mint landing and the id being written back.
  const halfWritten = {
    ...(unregistered as AgentRecord),
    registrationTx: `0x${'a'.repeat(64)}`,
  };
  assert.match(alreadyRegistered(halfWritten, {}) ?? '', /registration tx/);
});

test('the local ledger still skips an agent the shared registry has not caught up with', () => {
  assert.ok(unregistered, 'every agent is registered; nothing left to plan');
  const ledger: RegistryLedger = {
    [unregistered.slug]: { agentId: '269707', txHash: `0x${'b'.repeat(64)}` },
  };
  assert.match(alreadyRegistered(unregistered, ledger) ?? '', /269707/);
  assert.deepEqual(pendingRegistrations([unregistered], ledger), []);
});

test('an agent with no id, no tx and no ledger entry is the only kind that mints', () => {
  assert.ok(unregistered);
  assert.equal(alreadyRegistered(unregistered, {}), null);
  assert.deepEqual(pendingRegistrations([unregistered], {}), [unregistered]);
});

test('a bare run mints only the agents that have no identity', () => {
  // What `pnpm register` with no flags would do from a fresh checkout: the
  // live agents are excluded, so they are neither preflighted nor signed for.
  const pending = pendingRegistrations(selectRecords(AGENT_LIST, undefined), {});
  assert.ok(pending.length > 0, 'nothing to register at all');
  assert.equal(
    pending.some((record) => record.tokenId !== null),
    false,
    'a registered agent reached the mint queue',
  );
});

/* ---------------------------- the chain check ---------------------------- */

function stubClient(answer: bigint | Error) {
  const calls: { address: string; functionName: string; args: unknown }[] = [];
  return {
    calls,
    async readContract(call: { address: string; functionName: string; args?: unknown }) {
      calls.push({ address: call.address, functionName: call.functionName, args: call.args });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test('a wallet that already holds an identity is refused before signing', async () => {
  const client = stubClient(BigInt(1));
  await assert.rejects(
    assertNoIdentityYet(client as never, REGISTRY, 'grid', WALLET),
    /already holds 1 ERC-8004 identity/,
  );
  assert.equal(client.calls[0]?.functionName, 'balanceOf');
  assert.equal(client.calls[0]?.address, REGISTRY);
});

test('a wallet with no identity passes, and the check is one read', async () => {
  const client = stubClient(BigInt(0));
  await assertNoIdentityYet(client as never, REGISTRY, 'grid-b', WALLET);
  assert.equal(client.calls.length, 1);
});

test('a registry read that does not answer stops the run rather than minting blind', async () => {
  const client = stubClient(new Error('rpc unavailable'));
  await assert.rejects(
    assertNoIdentityYet(client as never, REGISTRY, 'grid-b', WALLET),
    /refusing to mint without confirming/,
  );
});
