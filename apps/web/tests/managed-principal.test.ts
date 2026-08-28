import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitForManagedPrincipal } from '../src/lib/managed-principal';

describe('managed principal visibility', () => {
  it('waits through stale reads and returns the first balance covering the bootstrap minimum', async () => {
    const balances = [0n, 4n, 9n];
    const result = await waitForManagedPrincipal(async () => ({
      idleWei: balances.shift() ?? 0n,
      deployedWei: 1n,
    }), 10n, { attempts: 3, delayMs: 0 });
    assert.equal(result.idleWei + result.deployedWei, 10n);
  });

  it('fails instead of recording a stale principal', async () => {
    await assert.rejects(
      waitForManagedPrincipal(
        async () => ({ idleWei: 1n, deployedWei: 0n }),
        10n,
        { attempts: 2, delayMs: 0 },
      ),
      /not visible/,
    );
  });

  it('does not let an old position satisfy a new-deposit final-total threshold', async () => {
    const snapshots = [
      { idleWei: 100n, deployedWei: 0n },
      { idleWei: 110n, deployedWei: 0n },
    ];
    const result = await waitForManagedPrincipal(
      async () => snapshots.shift()!,
      110n,
      { attempts: 2, delayMs: 0 },
    );
    assert.equal(result.idleWei, 110n);
  });

  it('uses the remaining polling window after a transient RPC failure', async () => {
    let reads = 0;
    const result = await waitForManagedPrincipal(async () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary upstream timeout');
      return { idleWei: 10n, deployedWei: 0n };
    }, 10n, { attempts: 2, delayMs: 0 });
    assert.equal(result.idleWei, 10n);
    assert.equal(reads, 2);
  });

  it('reports the visibility error only after every transient read fails', async () => {
    let reads = 0;
    await assert.rejects(
      waitForManagedPrincipal(async () => {
        reads += 1;
        throw new Error('temporary upstream timeout');
      }, 10n, { attempts: 3, delayMs: 0 }),
      /not visible/,
    );
    assert.equal(reads, 3);
  });
});
