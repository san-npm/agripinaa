/**
 * Fan the managed-yield tick over every account the agent manages. One shared
 * Altana client; one router call per account per tick, bounded by the same
 * per-account breakers as own-capital mode. A failure on one account is logged
 * and skipped so it never blocks the others.
 */
import type { Client } from '@altananetwork/sdk';
import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import { isDebtCompleteRouterRuntime } from '@agripinaa/shared';

import { managedYieldTick, type ManagedPolicy } from './agents/yield';
import { deploymentForEntry, managedExecutor, recoveryDeploymentForEntry } from './executor';
import { loadManaged, managedHealthKey, removeManagedEntry, type ManagedHealth } from './managed';
import type { ManagerKeySet } from './manager-key';
import type { AgentContext } from './types';

/** Bound one five-minute sweep even when the public registry is at capacity. */
export const MAX_MANAGED_ENTRIES_PER_SWEEP = 100;

export function managedSweepBatch<T>(
  entries: readonly T[],
  cursor: number,
  limit = MAX_MANAGED_ENTRIES_PER_SWEEP,
): { entries: T[]; nextCursor: number } {
  if (entries.length === 0 || limit <= 0) return { entries: [], nextCursor: 0 };
  const safeCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  const start = ((safeCursor % entries.length) + entries.length) % entries.length;
  const count = Math.min(entries.length, Math.trunc(limit));
  const selected = Array.from({ length: count }, (_, offset) => entries[(start + offset) % entries.length]!);
  return { entries: selected, nextCursor: (start + count) % entries.length };
}

export function healthAfterManagedTick(
  previous: ManagedHealth | null,
  executionStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | undefined,
  now = Date.now(),
  tickError?: string,
): ManagedHealth {
  if (tickError) return { at: now, result: 'error', reason: tickError, requiresExecutionRecovery: true };
  if (executionStatus === 'FAILED') {
    return {
      at: now,
      result: 'error',
      reason: 'the latest managed execution failed',
      requiresExecutionRecovery: true,
    };
  }
  // A read-only policy tick cannot prove that a previously failing relay path
  // recovered. Keep the error until an actual execution is accepted/confirmed,
  // but refresh the heartbeat: a successful sweep still proves the runner is
  // alive even when its last write failure remains unresolved.
  if (previous?.result === 'error' && previous.requiresExecutionRecovery && executionStatus == null) {
    return { ...previous, at: now };
  }
  return { at: now, result: 'ready' };
}

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
}): Promise<{ serviced: number; recoveryOnly: number; errors: number }> {
  const { ctx, client, managerKeys, policy } = opts;
  const allEntries = loadManaged(ctx.name);
  const sweepCursorKey = 'managed:sweepCursor';
  const batch = managedSweepBatch(
    allEntries,
    ctx.state.get<number>(sweepCursorKey, 0),
  );
  // Advance before external reads. A process crash can defer this batch until
  // the cursor wraps, but cannot pin every later mandate behind one bad entry.
  ctx.state.set(sweepCursorKey, batch.nextCursor);
  const entries = batch.entries;
  let serviced = 0;
  let recoveryOnly = 0;
  let errors = 0;
  let cursor = 0;
  const serviceNext = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]!;
    try {
      if (entry.session.expiry * 1000 <= Date.now()) {
        removeManagedEntry(ctx.name, entry);
        ctx.log({ event: 'managed-pruned', account: entry.account, reason: 'expired' });
        continue;
      }
      // Pick the manager key for the entry's TOKEN, resolved from its scoped
      // router — NOT from the session's own claimed public key. This binds
      // signing to the router's token: the executor then asserts the chosen key
      // also matches the granted session, so a stale entry granted to the wrong
      // token's key (e.g. a pre-fix USDC grant issued against the USDT key) is
      // rejected here instead of being serviced with the wrong key.
      const dep = deploymentForEntry(entry);
      if (!dep && recoveryDeploymentForEntry(entry)) {
        // Planned retirement/incomplete guard is a lifecycle state, not an
        // operational error. Preserve the record for owner recovery but do no
        // RPC/relay work and emit no repeated five-minute error.
        recoveryOnly += 1;
        continue;
      }
      if (!dep || !await isDebtCompleteRouterRuntime({
        getCode: ({ address }) => ctx.publicClient.getCode({ address }),
        readContract: (args) => ctx.publicClient.readContract(args),
      }, dep)) {
        if (dep) ctx.state.set(managedHealthKey(entry.account, dep.address), {
          at: Date.now(),
          result: 'error',
          reason: 'router runtime attestation failed',
        } satisfies ManagedHealth);
        errors += 1;
        ctx.log({ event: 'managed-error', account: entry.account, error: 'router runtime attestation failed' });
        continue;
      }
      const live = await isSessionKeyValid({
        chainId: entry.chainId,
        account: entry.account,
        sessionPublicKey: entry.session.publicKey,
      });
      if (!live) {
        removeManagedEntry(ctx.name, entry);
        ctx.log({ event: 'managed-pruned', account: entry.account, reason: 'revoked-or-invalid' });
        continue;
      }
      const managerKey = dep ? managerKeys.byToken.get(dep.symbol) : undefined;
      if (!managerKey) {
        ctx.state.set(managedHealthKey(entry.account, dep.address), {
          at: Date.now(),
          result: 'error',
          reason: 'no manager key for scoped token',
        } satisfies ManagedHealth);
        errors += 1;
        ctx.log({
          event: 'managed-error',
          account: entry.account,
          error: 'no manager key for the entry\'s scoped router token (stale or foreign grant)',
        });
        continue;
      }
      const baseExecutor = managedExecutor({ client, managerKey: managerKey.privateKey, entry });
      let executionStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' | undefined;
      const executor = {
        ...baseExecutor,
        async execute(action: Parameters<typeof baseExecutor.execute>[0]) {
          const result = await baseExecutor.execute(action);
          executionStatus = result.status;
          return result;
        },
      };
      const tickOutcome = await managedYieldTick(ctx, executor, policy);
      const healthKey = managedHealthKey(entry.account, dep.address);
      const health = healthAfterManagedTick(
        ctx.state.get<ManagedHealth | null>(healthKey, null),
        executionStatus,
        undefined,
        tickOutcome?.reason,
      );
      ctx.state.set(healthKey, health);
      if (health.result === 'error') {
        errors += 1;
        continue;
      }
      serviced += 1;
    } catch (err) {
      const dep = deploymentForEntry(entry);
      if (dep) ctx.state.set(managedHealthKey(entry.account, dep.address), {
        at: Date.now(),
        result: 'error',
        reason: err instanceof Error ? err.message : String(err),
      } satisfies ManagedHealth);
      errors += 1;
      ctx.log({
        event: 'managed-error',
        account: entry.account,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    }
  };
  // Independent accounts can be read/relayed concurrently; four workers keep
  // an accumulated historical registry from delaying every later mandate.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => serviceNext()));
  return { serviced, recoveryOnly, errors };
}
