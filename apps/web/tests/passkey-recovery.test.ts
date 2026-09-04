import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const recoveryModule = pathToFileURL(join(
  process.cwd(),
  'node_modules/@altananetwork/sdk/dist/recoverFromPasskey.js',
)).href;

test('recovers only the unique pending relay passkey admin', async () => {
  const { selectPendingAdminPublicKey } = await import(recoveryModule) as {
    selectPendingAdminPublicKey(keys: unknown[]): string;
  };
  const admin = { role: 'admin', type: 'webauthn-p256', publicKey: `0x${'11'.repeat(64)}` };
  const session = { role: 'session', type: 'secp256k1', publicKey: `0x${'22'.repeat(64)}` };

  assert.equal(selectPendingAdminPublicKey([session, admin]), admin.publicKey);
  assert.throws(
    () => selectPendingAdminPublicKey([admin, { ...admin, publicKey: `0x${'33'.repeat(64)}` }]),
    /no unique passkey admin/,
  );
});
