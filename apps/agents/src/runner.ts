/**
 * Agent runner: one long-lived process hosting every agent's tick loop plus
 * the shared x402 status server. Overlap-guarded intervals, exponential
 * error backoff per agent, breakers respected before every tick.
 *
 * Usage: pnpm --filter @agripinaa/agents start [-- --only grid,yield]
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN, agentBySlug, managedStrategyFor } from '@agripinaa/shared';

import { assertModulesRegistered, isUnprovisioned, MANAGED_AGENT_SLUGS } from './agent-config';
import { buildContext, DATA_DIR, ensureDataDir, hasAgentWallet } from './chassis';
import { createAltanaClient } from './executor';
import { buildManagerKeySet, type ManagerKeySet } from './manager-key';
import { tickManagedYield } from './managed-runner';
import { tickManagedStrategy } from './managed-strategy-runner';
import { startX402Server, type ManagerIdentity, type ManagerSet } from './x402-server';
import type { AgentContext, AgentModule } from './types';
import { policyForAgent } from './yield-policy';
import type { ManagedPolicy } from './agents/yield';
import { gridAgent } from './agents/grid';
import { gridBAgent } from './agents/grid-b';
import { healthFactorAgent } from './agents/health-factor';
import { venusGuardianAgent } from './agents/venus-guardian';
import { yieldAgent } from './agents/yield';
import { yieldBAgent } from './agents/yield-b';
import { lpRangeAgent } from './agents/lp-range';
import { weightRebalancerAgent } from './agents/weight-rebalancer';

const ALL: AgentModule[] = [
  gridAgent,
  gridBAgent,
  healthFactorAgent,
  venusGuardianAgent,
  yieldAgent,
  yieldBAgent,
  lpRangeAgent,
  weightRebalancerAgent,
];
/** Agents that can manage user funds (grant a scoped session to their manager key). */
const MANAGED_AGENTS = MANAGED_AGENT_SLUGS;
const PORT = Number(process.env.AGENTS_PORT ?? 4410);
/** Managed accounts are serviced faster than own-capital (6h) so deposits deploy promptly. */
const MANAGED_TICK_MS = Number(process.env.AGENTS_MANAGED_TICK_MS ?? 5 * 60_000);

function selectedModules(): AgentModule[] {
  const i = process.argv.indexOf('--only');
  if (i < 0) return ALL;
  const names = (process.argv[i + 1] ?? '').split(',');
  return ALL.filter((m) => names.includes(m.name));
}

/**
 * Exclusive run lock: the agents' overlap guard and rate limits are
 * process-local, so two runners (e.g. the systemd service AND the local
 * start script) would double-fire orders and bypass daily caps. Refuse to
 * start if another live process holds the lock; a stale lock (dead pid) is
 * reclaimed.
 */
function acquireRunLock(): string {
  ensureDataDir();
  const lock = join(DATA_DIR, 'runner.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx'); // the only operation that wins the lease
      try {
        writeFileSync(fd, String(process.pid));
      } catch (writeError) {
        // We created this inode, so a failed PID write cannot describe a live
        // holder. Remove it rather than leaving an unrecoverable malformed lock.
        try {
          unlinkSync(lock);
        } catch {
          /* preserve the original write failure */
        }
        throw writeError;
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = Number.NaN;
      try {
        holder = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readError;
      }
      if (!Number.isSafeInteger(holder) || holder <= 0) {
        throw new Error(`runner lock is malformed; refusing to remove a possibly live lease: ${lock}`);
      }
      let holderIsDead = false;
      try {
        process.kill(holder, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        holderIsDead = true;
      }
      if (!holderIsDead) {
        throw new Error(
          `another agent runner is live (pid ${holder}); refusing to start a second (would double-trade)`,
        );
      }
      // Remove a dead holder, then loop back through O_EXCL. Two contenders
      // can both observe the stale pid, but only one can win the next `wx`.
      try {
        unlinkSync(lock);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  if (!acquired) throw new Error('could not acquire the agent runner lock');
  const release = () => {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
  return lock;
}

async function main() {
  // Before anything acquires a lock, opens a port, or signs: a module with no
  // registry record has no token id, no manifest, and no proof-feed identity,
  // so it would trade with nothing on the marketplace pointing at it.
  assertModulesRegistered(ALL);
  acquireRunLock();
  const modules = selectedModules();
  const agents = new Map<string, { module: AgentModule; ctx: AgentContext }>();

  for (const module of modules) {
    // An agent may be configured before its wallet exists (the address is not
    // knowable until the key is generated). Skip it with a line in the log
    // rather than letting buildContext's missing-key throw take every other
    // agent's tick loop down at boot. A record that already carries a wallet
    // address still fails loudly, because then the key is absent.
    const record = agentBySlug(module.name);
    if (record && isUnprovisioned(record, hasAgentWallet(module.name))) {
      console.log(
        `${module.name}: skipped, no wallet yet (run fund --gen --only agent-${record.slug})`,
      );
      continue;
    }
    const ctx = await buildContext(module.name);
    agents.set(module.name, { module, ctx });
    ctx.log({ event: 'boot', category: module.category, tickMs: module.tickIntervalMs });
  }

  const facilitatorFile = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'wallets', 'facilitator.json',
  );
  const { privateKey } = JSON.parse(readFileSync(facilitatorFile, 'utf8')) as {
    privateKey: `0x${string}`;
  };

  // Managed mode: for each managed-capable agent that is running AND has a
  // manager key, publish its public identity (so the browser can grant to it)
  // and drive a per-account router tick loop.
  // The PRIMARY managed token keeps the master key (so a live mandate keeps
  // running untouched); every other token derives its own distinct key, so the
  // two tokens never share an on-chain key identity/expiry/revocation. Which
  // token that is comes from PRIMARY_MANAGED_TOKEN, never from the first entry
  // of the display array: that array is the wizard's button order, and a
  // cosmetic reorder there used to move the master key off USDT, which would
  // strand every live USDT mandate at the executor's signer check.
  const managers = new Map<string, ManagerSet>();
  const managerKeySets = new Map<string, { keySet: ManagerKeySet; policy: ManagedPolicy }>();
  const strategyKeySets = new Map<string, { keySet: ManagerKeySet; module: AgentModule }>();
  for (const name of MANAGED_AGENTS) {
    if (!agents.has(name)) continue;
    const policy = policyForAgent(name);
    const strategy = managedStrategyFor(name);
    if (!policy && !strategy) {
      agents.get(name)!.ctx.log({
        event: 'managed-disabled',
        level: 'warn',
        reason: `no managed execution policy registered for ${name}`,
      });
      continue;
    }
    const keySet = buildManagerKeySet(name, MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN);
    if (!keySet) {
      agents.get(name)!.ctx.log({
        event: 'managed-disabled',
        reason: `no wallets/agent-${name}-session.json; run fund --gen`,
      });
      continue;
    }
    const byToken = new Map<string, ManagerIdentity>();
    for (const [sym, k] of keySet.byToken) byToken.set(sym, { publicKey: k.publicKey, address: k.address });
    managers.set(name, {
      master: { publicKey: keySet.master.publicKey, address: keySet.master.address },
      byToken,
    });
    if (policy) managerKeySets.set(name, { keySet, policy });
    if (strategy) strategyKeySets.set(name, { keySet, module: agents.get(name)!.module });
  }

  startX402Server({ port: PORT, facilitatorKey: privateKey, agents, managers });
  console.log(`x402 status server on :${PORT} (${[...agents.keys()].join(', ')})`);
  if (managers.size > 0) {
    console.log(`managed mode: ${[...managers.keys()].join(', ')}`);
  }

  if (managerKeySets.size > 0) {
    const client = createAltanaClient();
    for (const [name, { keySet, policy }] of managerKeySets) {
      const ctx = agents.get(name)!.ctx;
      let running = false;
      const loop = async () => {
        if (running) return;
        if (ctx.breakers.isHalted().halted) return;
        running = true;
        try {
          const { serviced, recoveryOnly, errors } = await tickManagedYield({
            ctx,
            client,
            managerKeys: keySet,
            policy,
          });
          if (serviced > 0 || errors > 0) {
            ctx.log({ event: 'managed-sweep', serviced, recoveryOnly, errors });
          }
        } catch (err) {
          ctx.log({
            event: 'managed-sweep-error',
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          running = false;
        }
      };
      void loop();
      setInterval(loop, MANAGED_TICK_MS);
    }
  }

  if (strategyKeySets.size > 0) {
    const client = createAltanaClient();
    for (const [name, { keySet, module }] of strategyKeySets) {
      const ctx = agents.get(name)!.ctx;
      const managerKey = keySet.byToken.get('USDT');
      if (!managerKey) {
        ctx.log({ event: 'managed-disabled', reason: 'no USDT manager key for strategy mandates' });
        continue;
      }
      let running = false;
      const loop = async () => {
        // The own-capital account has its own breaker state. A drawdown halt on
        // that demo wallet must not disable unrelated public mandates; each
        // managed account is checked against its namespaced breaker below.
        if (running) return;
        running = true;
        try {
          const result = await tickManagedStrategy({ ctx, module, client, managerKey });
          if (result.serviced > 0 || result.errors > 0) {
            ctx.log({ event: 'managed-strategy-sweep', ...result });
          }
        } catch (err) {
          ctx.log({
            event: 'managed-strategy-sweep-error',
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          running = false;
        }
      };
      void loop();
      setInterval(loop, MANAGED_TICK_MS);
    }
  }

  for (const { module, ctx } of agents.values()) {
    let running = false;
    let backoffMs = 0;
    const loop = async () => {
      if (running) return;
      const halted = ctx.breakers.isHalted();
      if (halted.halted) return;
      if (backoffMs > 0) {
        backoffMs = Math.max(0, backoffMs - module.tickIntervalMs);
        return;
      }
      running = true;
      try {
        await module.tick(ctx);
      } catch (err) {
        backoffMs = Math.min((backoffMs || module.tickIntervalMs) * 2, 30 * 60_000);
        ctx.log({
          event: 'tick-error',
          error: err instanceof Error ? err.message : String(err),
          backoffMs,
        });
      } finally {
        running = false;
      }
    };
    void loop();
    setInterval(loop, module.tickIntervalMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
