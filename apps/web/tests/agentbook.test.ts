import assert from 'node:assert/strict';
import { test } from 'node:test';

import { foldAgentBook } from '../src/lib/agentbook';

test('any registration wins, one absence beats an outage, and only silence is unavailable', () => {
  const at = '2026-09-13T00:00:00.000Z';
  assert.deepEqual(
    foldAgentBook([{ status: 'unavailable' }, { status: 'registered', humanId: '0x1', registry: 'base' }], at),
    { status: 'registered', humanId: '0x1', registry: 'base', asOf: at },
  );
  assert.deepEqual(foldAgentBook([{ status: 'absent' }, { status: 'unavailable' }], at), { status: 'absent', asOf: at });
  assert.deepEqual(foldAgentBook([{ status: 'unavailable' }, { status: 'unavailable' }], at), { status: 'unavailable', asOf: at });
  assert.deepEqual(foldAgentBook([], at), { status: 'unavailable', asOf: at });
});
