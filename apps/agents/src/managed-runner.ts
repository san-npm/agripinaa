/**
 * Fan the managed-yield tick over every account the agent manages. One shared
 * Altana client; one router call per account per tick, bounded by the same
 * per-account breakers as own-capital mode. A failure on one account is logged
 * and skipped so it never blocks the others.
 */
import type { Client } from '@altananetwork/sdk';

import { managedYieldTick } from './agents/yield';
import { managedExecutor } from './executor';
import { loadManaged } from './managed';
import type { ManagerKey } from './manager-key';
import type { AgentContext } from './types';

export async function tickManagedYield(opts: {
  ctx: AgentContext;
  client: Client;
  /** Every candidate manager key by lowercase public key (one per token). */
  managerKeys: Map<string, ManagerKey>;
}): Promise<{ serviced: number; errors: number }> {
  const { ctx, client, managerKeys } = opts;
  const entries = loadManaged(ctx.name);
  let serviced = 0;
  let errors = 0;
  for (const entry of entries) {
    try {
      // Sign with the manager key the session was actually granted to (which
      // pins the token). If no candidate key matches the stored public key,
      // fail closed for this entry rather than signing with the wrong token's
      // key: the executor also re-checks this, this is the first gate.
      const pub = entry.session.publicKey?.toLowerCase();
      const managerKey = pub ? managerKeys.get(pub) : undefined;
      if (!managerKey) {
        errors += 1;
        ctx.log({
          event: 'managed-error',
          account: entry.account,
          error: 'no manager key matches the granted session public key (stale or foreign grant)',
        });
        continue;
      }
      const executor = managedExecutor({ client, managerKey: managerKey.privateKey, entry });
      await managedYieldTick(ctx, executor);
      serviced += 1;
    } catch (err) {
      errors += 1;
      ctx.log({
        event: 'managed-error',
        account: entry.account,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { serviced, errors };
}
