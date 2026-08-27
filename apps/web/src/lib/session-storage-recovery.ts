/**
 * A session grant has already confirmed when local recovery storage runs.
 * If persistence fails, revocation is the only safe compensation; preserve a
 * distinct critical error when even that network operation cannot be proven.
 */
export async function compensateSessionStorageFailure(input: {
  storageError: unknown;
  revoke: () => Promise<{ status: string }>;
}): Promise<never> {
  let revoked: { status: string };
  try {
    revoked = await input.revoke();
  } catch (revokeError) {
    throw new Error(
      `CRITICAL: recovery storage failed and automatic revocation also failed. Revoke the new key from the wallet interface immediately. ${
        revokeError instanceof Error ? revokeError.message : ''
      }`.trim(),
    );
  }
  if (revoked.status !== 'CONFIRMED') {
    throw new Error(
      'CRITICAL: recovery storage failed and the compensating session revocation did not confirm. Revoke the new key from the wallet interface immediately.',
    );
  }
  throw new Error(
    `Recovery storage failed; the new session was revoked. ${
      input.storageError instanceof Error ? input.storageError.message : ''
    }`.trim(),
  );
}
