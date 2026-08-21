/**
 * Agent runner: one long-lived process hosting every agent's tick loop plus
 * the shared x402 status server. Overlap-guarded intervals, exponential
 * error backoff per agent, breakers respected before every tick.
 *
 * Usage: pnpm --filter @agripinaa/agents start [-- --only grid,yield]
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANAGED_TOKENS } from '@agripinaa/shared';

import { buildContext } from './chassis';
import { createAltanaClient } from './executor';
import { buildManagerKeySet, type ManagerKeySet } from './manager-key';
import { tickManagedYield } from './managed-runner';
import { startX402Server, type ManagerIdentity, type ManagerSet } from './x402-server';
import type { AgentContext, AgentModule } from './types';
import { gridAgent } from './agents/grid';
import { healthFactorAgent } from './agents/health-factor';
import { yieldAgent } from './agents/yield';
import { lpRangeAgent } from './agents/lp-range';

const ALL: AgentModule[] = [gridAgent, healthFactorAgent, yieldAgent, lpRangeAgent];
/** Agents that can manage user funds (grant a scoped session to their manager key). */
const MANAGED_AGENTS = ['yield'] as const;
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
  const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'runner.lock');
  try {
    const fd = openSync(lock, 'wx'); // fails if it exists
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holder = Number.parseInt(readFileSync(lock, 'utf8').trim(), 10);
    let alive = false;
    try {
      process.kill(holder, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(
        `another agent runner is live (pid ${holder}); refusing to start a second (would double-trade)`,
      );
    }
    writeFileSync(lock, String(process.pid));
  }
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
  acquireRunLock();
  const modules = selectedModules();
  const agents = new Map<string, { module: AgentModule; ctx: AgentContext }>();

  for (const module of modules) {
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
  // two tokens never share an on-chain key identity/expiry/revocation.
  const PRIMARY_TOKEN = MANAGED_TOKENS[0];
  const managers = new Map<string, ManagerSet>();
  const managerKeySets = new Map<string, ManagerKeySet>();
  for (const name of MANAGED_AGENTS) {
    if (!agents.has(name)) continue;
    const keySet = buildManagerKeySet(name, MANAGED_TOKENS, PRIMARY_TOKEN);
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
    managerKeySets.set(name, keySet);
  }

  startX402Server({ port: PORT, facilitatorKey: privateKey, agents, managers });
  console.log(`x402 status server on :${PORT} (${[...agents.keys()].join(', ')})`);
  if (managers.size > 0) {
    console.log(`managed mode: ${[...managers.keys()].join(', ')}`);
  }

  if (managerKeySets.size > 0) {
    const client = createAltanaClient();
    for (const [name, keySet] of managerKeySets) {
      const ctx = agents.get(name)!.ctx;
      let running = false;
      const loop = async () => {
        if (running) return;
        if (ctx.breakers.isHalted().halted) return;
        running = true;
        try {
          const { serviced, errors } = await tickManagedYield({ ctx, client, managerKeys: keySet });
          if (serviced > 0 || errors > 0) {
            ctx.log({ event: 'managed-sweep', serviced, errors });
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
