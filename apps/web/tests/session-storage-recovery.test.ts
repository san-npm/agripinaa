import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compensateSessionStorageFailure } from '../src/lib/session-storage-recovery';

test('storage failure reports a confirmed compensating revocation', async () => {
  let checkpointClears = 0;
  await assert.rejects(
    compensateSessionStorageFailure({
      storageError: new Error('quota exceeded'),
      revoke: async () => ({ status: 'CONFIRMED' }),
      afterConfirmedRevocation: () => { checkpointClears += 1; },
    }),
    /new session was revoked.*quota exceeded/,
  );
  assert.equal(checkpointClears, 1);
});

test('storage plus revocation failure surfaces the orphaned-authority recovery path', async () => {
  let checkpointClears = 0;
  await assert.rejects(
    compensateSessionStorageFailure({
      storageError: new Error('quota exceeded'),
      revoke: async () => { throw new Error('relay offline'); },
      afterConfirmedRevocation: () => { checkpointClears += 1; },
    }),
    /CRITICAL:.*Revoke the new key.*relay offline/,
  );
  assert.equal(checkpointClears, 0);
});

test('an unconfirmed compensating revocation is also critical', async () => {
  let checkpointClears = 0;
  await assert.rejects(
    compensateSessionStorageFailure({
      storageError: new Error('quota exceeded'),
      revoke: async () => ({ status: 'PENDING' }),
      afterConfirmedRevocation: () => { checkpointClears += 1; },
    }),
    /CRITICAL:.*did not confirm.*Revoke the new key/,
  );
  assert.equal(checkpointClears, 0);
});
