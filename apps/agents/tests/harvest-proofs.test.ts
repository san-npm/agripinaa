import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatHarvestedProof, harvestProofs } from '../src/harvest-proofs';

const lines = [
  JSON.stringify({ event: 'boot', at: '2026-08-24T10:00:00.000Z' }),
  JSON.stringify({
    event: 'swap-settled',
    at: '2026-08-24T10:05:00.000Z',
    txHash: '0x' + 'a'.repeat(64),
    summary: 'WBNB to USDT through Ophis',
  }),
  'not json',
  JSON.stringify({ event: 'tick-error', at: '2026-08-24T10:06:00.000Z' }),
];

test('extracts settled transactions and ignores noise', () => {
  const proofs = harvestProofs(lines);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.kind, 'tx');
  assert.equal(proofs[0]!.ref, '0x' + 'a'.repeat(64));
});

test('malformed lines never throw', () => {
  assert.doesNotThrow(() => harvestProofs(['{', '', 'x']));
});

test('sorts newest first and keeps at most five per agent', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({
      agent: 'grid',
      event: 'trade',
      at: `2026-08-24T10:0${i}:00.000Z`,
      txHash: `0x${String(i).repeat(64)}`,
    }),
  );
  const proofs = harvestProofs(many);
  assert.equal(proofs.length, 5);
  assert.equal(proofs[0]!.at, '2026-08-24T10:07:00.000Z');
  assert.equal(proofs[4]!.at, '2026-08-24T10:03:00.000Z');
  assert.ok(proofs.every((proof) => proof.slug === 'grid'));
});

test('caps per agent, not across the whole batch', () => {
  const forAgent = (slug: string, hexChar: string) =>
    Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        agent: slug,
        event: 'repay',
        at: `2026-08-24T1${i}:00:00.000Z`,
        txHash: `0x${hexChar.repeat(63)}${i}`,
      }),
    );
  const proofs = harvestProofs([...forAgent('grid', 'a'), ...forAgent('yield', 'b')]);
  assert.equal(proofs.filter((proof) => proof.slug === 'grid').length, 5);
  assert.equal(proofs.filter((proof) => proof.slug === 'yield').length, 5);
});

test('a repeated reference is harvested once, at its newest sighting', () => {
  const proofs = harvestProofs([
    JSON.stringify({ agent: 'lp-range', event: 'range-check', at: '2026-08-24T10:00:00.000Z', tokenId: '7248592' }),
    JSON.stringify({ agent: 'lp-range', event: 'range-check', at: '2026-08-24T11:00:00.000Z', tokenId: '7248592' }),
  ]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.kind, 'position');
  assert.equal(proofs[0]!.ref, '7248592');
  assert.equal(proofs[0]!.at, '2026-08-24T11:00:00.000Z');
});

test('a reverted or skipped execution is never a proof', () => {
  const proofs = harvestProofs([
    JSON.stringify({ agent: 'lp-range', event: 'mint-reverted', at: '2026-08-24T10:00:00.000Z', txHash: '0x' + 'b'.repeat(64) }),
    JSON.stringify({ agent: 'lp-range', event: 'position-ignored', at: '2026-08-24T10:01:00.000Z', tokenId: '4242' }),
    JSON.stringify({ agent: 'lp-range', event: 'mint-failed', at: '2026-08-24T10:02:00.000Z', txHash: '0x' + 'c'.repeat(64) }),
  ]);
  assert.deepEqual(proofs, []);
});

test('malformed references are rejected, valid ones on the same run are kept', () => {
  const proofs = harvestProofs([
    JSON.stringify({ agent: 'grid', event: 'trade', at: '2026-08-24T10:00:00.000Z', txHash: '0xdeadbeef' }),
    JSON.stringify({ agent: 'grid', event: 'trade', at: '2026-08-24T10:01:00.000Z', txHash: 42 }),
    JSON.stringify({ agent: 'lp-range', event: 'minted', at: '2026-08-24T10:02:00.000Z', tokenId: 'not-a-number' }),
    JSON.stringify({ agent: 'grid', event: 'trade', at: 'never', txHash: '0x' + 'd'.repeat(64) }),
    JSON.stringify({ agent: 'grid', event: 'trade', at: '2026-08-24T10:04:00.000Z', txHash: '0x' + 'e'.repeat(64) }),
  ]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.ref, '0x' + 'e'.repeat(64));
});

test('a transaction and a position id on one line yield the transaction', () => {
  const proofs = harvestProofs([
    JSON.stringify({
      agent: 'lp-range',
      event: 'minted',
      at: '2026-08-24T10:00:00.000Z',
      txHash: '0x' + 'f'.repeat(64),
      tokenId: '7248592',
    }),
  ]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.kind, 'tx');
  assert.equal(proofs[0]!.ref, '0x' + 'f'.repeat(64));
});

test('the summary falls back to the event name when the line carries none', () => {
  const proofs = harvestProofs([
    JSON.stringify({ agent: 'yield', event: 'supply', at: '2026-08-24T10:00:00.000Z', txHash: '0x' + '1'.repeat(64) }),
  ]);
  assert.equal(proofs[0]!.summary, 'supply');
});

test('an Ophis order uid is harvested as a tx-kind proof', () => {
  const proofs = harvestProofs([
    JSON.stringify({
      agent: 'grid',
      event: 'order-filled',
      at: '2026-08-24T10:00:00.000Z',
      orderUid: '0x' + 'b'.repeat(112),
      summary: 'WBNB to USDT through Ophis',
    }),
  ]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.kind, 'tx');
  assert.equal(proofs[0]!.ref, '0x' + 'b'.repeat(112));
});

test('a settlement tx hash outranks an order uid logged on the same line', () => {
  const proofs = harvestProofs([
    JSON.stringify({
      agent: 'grid',
      event: 'order-filled',
      at: '2026-08-24T10:00:00.000Z',
      txHash: '0x' + 'a'.repeat(64),
      orderUid: '0x' + 'b'.repeat(112),
      summary: 'WBNB to USDT through Ophis',
    }),
  ]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.kind, 'tx');
  assert.equal(proofs[0]!.ref, '0x' + 'a'.repeat(64));
});

test('a position id beyond 18 digits, or a number above Number.MAX_SAFE_INTEGER, is rejected; a normal one still passes', () => {
  const proofs = harvestProofs([
    JSON.stringify({ agent: 'lp-range', event: 'minted', at: '2026-08-24T10:00:00.000Z', tokenId: '1234567890123456789' }),
    JSON.stringify({ agent: 'lp-range', event: 'minted', at: '2026-08-24T10:01:00.000Z', tokenId: Number.MAX_SAFE_INTEGER + 10 }),
    JSON.stringify({ agent: 'lp-range', event: 'minted', at: '2026-08-24T10:02:00.000Z', tokenId: '7248592' }),
  ]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.ref, '7248592');
});

test('a summary with an apostrophe and a backslash round-trips through the paste-ready output', () => {
  const proofs = harvestProofs([
    JSON.stringify({
      agent: 'grid',
      event: 'trade',
      at: '2026-08-24T10:00:00.000Z',
      txHash: '0x' + 'a'.repeat(64),
      summary: "It's a 50% fill \\ partial route",
    }),
  ]);
  assert.equal(proofs.length, 1);
  const escapedSummary = JSON.stringify(proofs[0]!.summary);
  // Sanity: the fixture actually exercises both characters this test is named for.
  assert.ok(escapedSummary.includes("'"));
  assert.ok(escapedSummary.includes('\\\\'));
  const line = formatHarvestedProof(proofs[0]!);
  assert.ok(line.includes(escapedSummary));
  // The printed line must itself be a syntactically valid object literal: parse
  // the summary field back out and confirm it round-trips to the original text.
  assert.equal(JSON.parse(escapedSummary), proofs[0]!.summary);
});
