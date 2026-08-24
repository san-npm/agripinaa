/**
 * Fan the managed-yield tick over every account the agent manages. One shared
 * Altana client; one router call per account per tick, bounded by the same
 * per-account breakers as own-capital mode. A failure on one account is logged
 * and skipped so it never blocks the others.
 */
import type { Client } from '@altananetwork/sdk';

import { managedYieldTick, type ManagedPolicy } from './agents/yield';
import { deploymentForEntry, managedExecutor } from './executor';
import { loadManaged } from './managed';
import type { ManagerKeySet } from './manager-key';
import type { AgentContext } from './types';

export async function tickManagedYield(opts: {
  ctx: AgentContext;
  client: Client;
  /** The agent's manager keys (one per token, keyed by symbol). */
  managerKeys: ManagerKeySet;
  /**
   * This agent's rotation policy. Required rather than defaulted: more than one
   * agent manages funds on the same router now, and a caller that forgot to
   * pass one would hand a depositor the other agent's policy without a word.
   */
  policy: ManagedPolicy;
}): Promise<{ serviced: number; errors: number }> {
  const { ctx, client, managerKeys, policy } = opts;
  const entries = loadManaged(ctx.name);
  let serviced = 0;
  let errors = 0;
  for (const entry of entries) {
    try {
      // Pick the manager key for the entry's TOKEN, resolved from its scoped
      // router — NOT from the session's own claimed public key. This binds
      // signing to the router's token: the executor then asserts the chosen key
      // also matches the granted session, so a stale entry granted to the wrong
      // token's key (e.g. a pre-fix USDC grant issued against the USDT key) is
      // rejected here instead of being serviced with the wrong key.
      const dep = deploymentForEntry(entry);
      const managerKey = dep ? managerKeys.byToken.get(dep.symbol) : undefined;
      if (!managerKey) {
        errors += 1;
        ctx.log({
          event: 'managed-error',
          account: entry.account,
          error: 'no manager key for the entry\'s scoped router token (stale or foreign grant)',
        });
        continue;
      }
      const executor = managedExecutor({ client, managerKey: managerKey.privateKey, entry });
      await managedYieldTick(ctx, executor, policy);
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
