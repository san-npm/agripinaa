/**
 * Fan the managed-yield tick over every account the agent manages. One shared
 * Altana client; one router call per account per tick, bounded by the same
 * per-account breakers as own-capital mode. A failure on one account is logged
 * and skipped so it never blocks the others.
 */
import type { Client } from '@altananetwork/sdk';
import type { Hex } from 'viem';

import { managedYieldTick } from './agents/yield';
import { managedExecutor } from './executor';
import { loadManaged } from './managed';
import type { AgentContext } from './types';

export async function tickManagedYield(opts: {
  ctx: AgentContext;
  client: Client;
  managerKey: Hex;
}): Promise<{ serviced: number; errors: number }> {
  const { ctx, client, managerKey } = opts;
  const entries = loadManaged(ctx.name);
  let serviced = 0;
  let errors = 0;
  for (const entry of entries) {
    try {
      const executor = managedExecutor({ client, managerKey, entry });
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
