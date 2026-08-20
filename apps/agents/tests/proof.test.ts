import assert from 'node:assert/strict';
import test from 'node:test';

import { mapProofLogEntries } from '../src/proof';

test('maps receipt-bearing agent actions into public proof events', () => {
  const events = mapProofLogEntries([
    {
      at: '2026-08-18T18:25:14.894Z',
      agent: 'yield',
      event: 'supply',
      venue: 'aave',
      amount: '2.4',
      txHash: `0x${'a'.repeat(64)}`,
    },
    {
      at: '2026-08-18T18:38:15.066Z',
      agent: 'health-factor',
      event: 'repair-done',
      repaidUsdt: '0.318059646689966885',
      txHash: `0x${'b'.repeat(64)}`,
    },
    {
      at: '2026-08-18T18:39:00.000Z',
      agent: 'health-factor',
      event: 'hf',
      hf: 1.602,
    },
  ]);

  assert.equal(events.length, 2);
  assert.equal(events[0]?.agent, '269704');
  assert.equal(events[0]?.kind, 'repair');
  assert.equal(events[0]?.hf, 1.602);
  assert.match(events[0]?.summary ?? '', /restoring HF to 1\.60/);
  assert.equal(events[1]?.agentName, 'Agripinaa Harvester');
  assert.equal(events[1]?.kind, 'rotate');
  assert.match(events[1]?.summary ?? '', /2\.4 USDT to Aave/);
});

test('collapses repetitive range telemetry without hiding action events', () => {
  const entries = [0, 1, 2].map((minutes) => ({
    at: `2026-08-18T18:${35 + minutes * 10}:12.000Z`,
    agent: 'lp-range',
    event: 'range-check',
    tokenId: '7173629',
    inRange: true,
  }));
  const events = mapProofLogEntries([
    ...entries,
    {
      at: '2026-08-18T18:25:16.414Z',
      agent: 'lp-range',
      event: 'minted',
      tokenId: '7173629',
      txHash: `0x${'c'.repeat(64)}`,
    },
  ]);

  assert.equal(events.filter((event) => event.summary.includes('remains in range')).length, 1);
  assert.equal(events.some((event) => event.kind === 'mint'), true);
});

test('ignores heartbeats, malformed receipts, and unknown agents', () => {
  const events = mapProofLogEntries([
    { at: '2026-08-18T18:25:00.000Z', agent: 'grid', event: 'tick' },
    { at: '2026-08-18T18:25:01.000Z', agent: 'yield', event: 'supply', txHash: 'nope' },
    { at: '2026-08-18T18:25:02.000Z', agent: 'other', event: 'minted', txHash: `0x${'d'.repeat(64)}` },
  ]);
  assert.deepEqual(events, []);
});
