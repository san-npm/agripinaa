import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compensateSessionStorageFailure } from '../src/lib/session-storage-recovery';

test('storage failure reports a confirmed compensating revocation', async () => {
  await assert.rejects(
    compensateSessionStorageFailure({
      storageError: new Error('quota exceeded'),
      revoke: async () => ({ status: 'CONFIRMED' }),
    }),
    /new session was revoked.*quota exceeded/,
  );
});

test('storage plus revocation failure surfaces the orphaned-authority recovery path', async () => {
  await assert.rejects(
    compensateSessionStorageFailure({
      storageError: new Error('quota exceeded'),
      revoke: async () => { throw new Error('relay offline'); },
    }),
    /CRITICAL:.*Revoke the new key.*relay offline/,
  );
});

test('an unconfirmed compensating revocation is also critical', async () => {
  await assert.rejects(
    compensateSessionStorageFailure({
      storageError: new Error('quota exceeded'),
      revoke: async () => ({ status: 'PENDING' }),
    }),
    /CRITICAL:.*did not confirm.*Revoke the new key/,
  );
});
