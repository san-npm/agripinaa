import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  CLAIM_INDEX_KEY,
  buildClaimMessage,
  claimIsStale,
  claimKey,
  decideClaim,
  getClaim,
  listClaims,
  sanitizeFields,
  saveClaim,
  verifyClaimSignature,
  type ClaimChain,
  type ClaimFields,
  type ClaimKv,
  type ClaimRecord,
} from '../src/lib/claims';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const fields = {
  chainId: 56,
  tokenId: '297380',
  description: 'A yield agent that rotates between BSC lending venues.',
  category: 'yield' as const,
  website: 'https://example.com',
  endpoint: 'https://agent.example.com/status',
  issuedAt: '2026-08-24T12:00:00.000Z',
};

test('a signature from the owner verifies', async () => {
  const signature = await account.signTypedData(buildClaimMessage(fields));
  assert.equal(await verifyClaimSignature({ fields, signature, owner: account.address }), true);
});

test('a signature from someone else does not verify', async () => {
  const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const signature = await other.signTypedData(buildClaimMessage(fields));
  assert.equal(await verifyClaimSignature({ fields, signature, owner: account.address }), false);
});

test('tampering with a field invalidates the signature', async () => {
  const signature = await account.signTypedData(buildClaimMessage(fields));
  const tampered = { ...fields, description: 'Something else entirely, longer than before.' };
  assert.equal(await verifyClaimSignature({ fields: tampered, signature, owner: account.address }), false);
});

test('field sanitisation caps lengths and rejects non-https urls', () => {
  const dirty = sanitizeFields({
    ...fields,
    description: 'x'.repeat(5_000),
    website: 'javascript:alert(1)',
    endpoint: 'http://insecure.example.com',
  });
  assert.ok(dirty.description.length <= 600);
  assert.equal(dirty.website, '');
  assert.equal(dirty.endpoint, '');
});

test('sanitisation is idempotent, so what the browser signs is what the server verifies', () => {
  const once = sanitizeFields({ ...fields, description: `  ${'y'.repeat(700)}  ` });
  assert.deepEqual(sanitizeFields(once), once);
});

test('a category outside the hubs becomes other, and an agent id keeps only its digits', () => {
  assert.equal(sanitizeFields({ ...fields, category: 'moonshots' }).category, 'other');
  assert.equal(sanitizeFields({ ...fields, category: 'grid' }).category, 'grid');
  assert.equal(sanitizeFields({ ...fields, tokenId: '000297380' }).tokenId, '297380');
  assert.equal(sanitizeFields({ ...fields, tokenId: '29 or 1=1' }).tokenId, '');
  assert.equal(sanitizeFields('nonsense').tokenId, '');
});

test('an endpoint on a private host is dropped even though it is https', () => {
  const dirty = sanitizeFields({ ...fields, endpoint: 'https://169.254.169.254/latest/meta-data' });
  assert.equal(dirty.endpoint, '');
});

/** A KV that keeps everything in a map, so no test in this file touches a network. */
interface TestKv extends ClaimKv {
  store: Map<string, string>;
}

function memoryKv(opts: { available?: boolean; writes?: boolean } = {}): TestKv {
  const store = new Map<string, string>();
  return {
    store,
    available: () => opts.available ?? true,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      if (opts.writes === false) return false;
      store.set(key, value);
      return true;
    },
    mget: async (keys) => keys.map((key) => store.get(key) ?? null),
  };
}

interface TestChain extends ClaimChain {
  reads: { ownerOf: number; hasBytecode: number };
}

function chainOwnedBy(owner: string | null, opts: { contract?: boolean } = {}): TestChain {
  const reads = { ownerOf: 0, hasBytecode: 0 };
  return {
    reads,
    ownerOf: async () => {
      reads.ownerOf += 1;
      return owner as Hex | null;
    },
    hasBytecode: async () => {
      reads.hasBytecode += 1;
      return opts.contract ?? false;
    },
  };
}

/** 30 seconds after the fixture's issuedAt: inside the replay window. */
const NOW = Date.parse('2026-08-24T12:00:30.000Z');
const HOUR = 60 * 60 * 1_000;

async function signedBody(
  signer = account,
  override: Partial<ClaimFields> = {},
): Promise<string> {
  const claim = sanitizeFields({ ...fields, ...override });
  return JSON.stringify({
    fields: claim,
    signature: await signer.signTypedData(buildClaimMessage(claim)),
  });
}

function decide(input: { body?: string; chain?: ClaimChain; kv?: ClaimKv; now?: number }) {
  return decideClaim({
    readBodyText: async () => input.body ?? '{}',
    chain: input.chain ?? chainOwnedBy(account.address),
    kv: input.kv ?? memoryKv(),
    now: () => input.now ?? NOW,
  });
}

test('a claim signed by the owner is stored, indexed, and counted', async () => {
  const kv = memoryKv();
  const decision = await decide({ body: await signedBody(), kv });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;

  assert.equal(decision.record.signer, account.address);
  assert.equal(decision.record.fields.description, fields.description);
  assert.equal(decision.record.savedAt, new Date(NOW).toISOString());
  assert.equal(kv.store.has(claimKey(56, '297380')), true);
  assert.deepEqual(JSON.parse(kv.store.get(CLAIM_INDEX_KEY)!), ['56:297380']);
  assert.deepEqual(
    JSON.parse(kv.store.get(`agripinaa:claim-rate:${account.address.toLowerCase()}`)!),
    [NOW],
  );
  assert.deepEqual(await listClaims(kv), [decision.record]);
});

test('a signature from a wallet that does not own the agent is refused', async () => {
  const stranger = privateKeyToAccount(`0x${'33'.repeat(32)}`);
  const kv = memoryKv();
  const decision = await decide({ body: await signedBody(stranger), kv });
  assert.deepEqual(decision, {
    ok: false,
    status: 401,
    message: 'connected wallet is not the owner of this agent',
  });
  // A stranger must not be able to spend the owner's hourly budget for them.
  assert.equal(kv.store.size, 0);
});

test('an owner that is a contract wallet is told so rather than called a stranger', async () => {
  const chain = chainOwnedBy('0x000000000000000000000000000000000000C0DE', { contract: true });
  const decision = await decide({ body: await signedBody(), chain });
  assert.deepEqual(decision, {
    ok: false,
    status: 400,
    message: 'claiming from a contract wallet is not supported yet',
  });
  assert.equal(chain.reads.hasBytecode, 1);
});

test('bytecode is never read for a claim that matches its owner', async () => {
  const chain = chainOwnedBy(account.address);
  const decision = await decide({ body: await signedBody(), chain });
  assert.equal(decision.ok, true);
  assert.equal(chain.reads.hasBytecode, 0);
});

test('an agent id with no owner on chain is refused', async () => {
  const decision = await decide({ body: await signedBody(), chain: chainOwnedBy(null) });
  assert.deepEqual(decision, {
    ok: false,
    status: 400,
    message: 'this agent id has no owner on chain',
  });
});

test('a claim signed outside the ten minute window is refused in both directions', async () => {
  const stale = await decide({ body: await signedBody(), now: NOW + 11 * 60 * 1_000 });
  const future = await decide({ body: await signedBody(), now: NOW - 11 * 60 * 1_000 });
  for (const decision of [stale, future]) {
    assert.equal(decision.ok, false);
    assert.equal(decision.ok === false && decision.status, 400);
    assert.equal(
      decision.ok === false && decision.message,
      'this claim was signed outside the ten minute window, please sign again',
    );
  }
});

test('a malformed request is refused without touching the chain', async () => {
  const cases: { body: string; message: string }[] = [
    { body: 'x'.repeat(17_000), message: 'body too large' },
    { body: 'not json at all', message: 'bad json' },
    { body: JSON.stringify({ fields }), message: 'bad signature' },
    { body: JSON.stringify({ fields, signature: '0xdeadbeef' }), message: 'bad signature' },
    {
      body: JSON.stringify({ fields: { ...fields, chainId: 97 }, signature: `0x${'ab'.repeat(65)}` }),
      message: 'claims are supported on bnb chain only',
    },
    {
      body: JSON.stringify({ fields: { ...fields, tokenId: 'nope' }, signature: `0x${'ab'.repeat(65)}` }),
      message: 'bad agent id',
    },
    {
      body: JSON.stringify({ fields: { ...fields, issuedAt: 'whenever' }, signature: `0x${'ab'.repeat(65)}` }),
      message: 'bad timestamp',
    },
  ];
  for (const { body, message } of cases) {
    const chain = chainOwnedBy(account.address);
    const decision = await decide({ body, chain });
    assert.equal(decision.ok === false && decision.message, message);
    assert.equal(decision.ok === false && decision.status, 400);
    assert.equal(chain.reads.ownerOf, 0, `${message} should not reach the chain`);
  }
});

test('a body that cannot be read at all is refused', async () => {
  const decision = await decideClaim({
    readBodyText: async () => {
      throw new Error('stream closed');
    },
    chain: chainOwnedBy(account.address),
    kv: memoryKv(),
    now: () => NOW,
  });
  assert.deepEqual(decision, { ok: false, status: 400, message: 'unreadable body' });
});

test('an unconfigured kv answers 503 before any chain read', async () => {
  const chain = chainOwnedBy(account.address);
  const decision = await decide({
    body: await signedBody(),
    chain,
    kv: memoryKv({ available: false }),
  });
  assert.deepEqual(decision, { ok: false, status: 503, message: 'kv not configured' });
  assert.equal(chain.reads.ownerOf, 0);
});

test('a claim that cannot be written answers 503 rather than reporting success', async () => {
  const decision = await decide({ body: await signedBody(), kv: memoryKv({ writes: false }) });
  assert.deepEqual(decision, { ok: false, status: 503, message: 'kv write failed' });
});

test('a sixth claim from the same owner within the hour is refused', async () => {
  const kv = memoryKv();
  const rateKey = `agripinaa:claim-rate:${account.address.toLowerCase()}`;
  kv.store.set(rateKey, JSON.stringify([NOW - 5, NOW - 4, NOW - 3, NOW - 2, NOW - 1]));
  const decision = await decide({ body: await signedBody(), kv });
  assert.deepEqual(decision, {
    ok: false,
    status: 429,
    message: 'too many claims from this owner in the last hour',
  });
  assert.equal(kv.store.has(claimKey(56, '297380')), false);
});

test('claims older than the hour do not count against the limit', async () => {
  const kv = memoryKv();
  const rateKey = `agripinaa:claim-rate:${account.address.toLowerCase()}`;
  kv.store.set(rateKey, JSON.stringify(Array.from({ length: 5 }, (_, i) => NOW - 2 * HOUR - i)));
  const decision = await decide({ body: await signedBody(), kv });
  assert.equal(decision.ok, true);
  assert.deepEqual(JSON.parse(kv.store.get(rateKey)!), [NOW]);
});

function recordFor(tokenId: string, signer: Hex): ClaimRecord {
  return {
    fields: sanitizeFields({ ...fields, tokenId }),
    signature: `0x${'ab'.repeat(65)}`,
    signer,
    savedAt: new Date(NOW).toISOString(),
  };
}

test('a claim survives a round trip and the index never repeats an id', async () => {
  const kv = memoryKv();
  assert.equal(await saveClaim(recordFor('297380', account.address), kv), true);
  assert.equal(await saveClaim(recordFor('297380', account.address), kv), true);

  const stored = await getClaim(56, '297380', { kv });
  assert.equal(stored?.fields.description, fields.description);
  assert.equal(stored?.signer, account.address);
  assert.deepEqual(JSON.parse(kv.store.get(CLAIM_INDEX_KEY)!), ['56:297380']);
  assert.equal((await listClaims(kv)).length, 1);
});

test('listing skips an indexed id whose record has gone', async () => {
  const kv = memoryKv();
  await saveClaim(recordFor('297380', account.address), kv);
  await saveClaim(recordFor('269703', account.address), kv);
  kv.store.delete(claimKey(56, '269703'));

  const claims = await listClaims(kv);
  assert.deepEqual(
    claims.map((c) => c.fields.tokenId),
    ['297380'],
  );
});

test('a transferred identity invalidates the claim its previous owner signed', async () => {
  const kv = memoryKv();
  const newOwner = privateKeyToAccount(`0x${'44'.repeat(32)}`).address;
  await saveClaim(recordFor('297380', account.address), kv);

  const record = (await getClaim(56, '297380', { kv }))!;
  assert.equal(claimIsStale(record, newOwner), true);
  assert.equal(claimIsStale(record, account.address.toLowerCase()), false);
  assert.equal(claimIsStale(record, null), false);
  assert.equal(await getClaim(56, '297380', { kv, currentOwner: newOwner }), null);
  assert.notEqual(await getClaim(56, '297380', { kv, currentOwner: account.address }), null);
});

test('a stored value that is not a claim is ignored rather than served', async () => {
  const kv = memoryKv();
  kv.store.set(claimKey(56, '297380'), 'not json at all');
  assert.equal(await getClaim(56, '297380', { kv }), null);

  kv.store.set(claimKey(56, '297380'), JSON.stringify({ fields, signature: 'nope', signer: 'nope' }));
  assert.equal(await getClaim(56, '297380', { kv }), null);
});

test('an agent with no claim reads as no claim', async () => {
  assert.equal(await getClaim(56, '111', { kv: memoryKv() }), null);
  assert.deepEqual(await listClaims(memoryKv()), []);
});
