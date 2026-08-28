export interface ManagedBalanceSnapshot {
  idleWei: bigint;
  deployedWei: bigint;
}

/**
 * A relay confirmation can precede a public RPC's view of the new balances.
 * Do not persist a principal until that separate read path sees at least the
 * full expected post-bootstrap position. Comparing only the new output is
 * unsafe for recovered accounts: an old position can already be larger than
 * the new deposit and make a stale read look current.
 */
export async function waitForManagedPrincipal<T extends ManagedBalanceSnapshot>(
  read: () => Promise<T>,
  expectedTotalWei: bigint,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 60;
  const delayMs = options.delayMs ?? 500;
  if (
    !Number.isSafeInteger(attempts)
    || attempts < 1
    || !Number.isSafeInteger(delayMs)
    || delayMs < 0
  ) {
    throw new Error('invalid managed-principal polling policy');
  }
  let lastReadError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const snapshot = await read();
      if (snapshot.idleWei + snapshot.deployedWei >= expectedTotalWei) return snapshot;
    } catch (error) {
      // Receipt availability and historical state can briefly disagree across
      // public RPC backends. Use the rest of the same bounded polling window.
      lastReadError = error;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    'The confirmed deposit is not visible from the account RPC yet. Wait a moment, then retry activation.',
    lastReadError === undefined ? undefined : { cause: lastReadError },
  );
}
