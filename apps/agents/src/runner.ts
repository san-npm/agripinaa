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

import { buildContext } from './chassis';
import { startX402Server } from './x402-server';
import type { AgentContext, AgentModule } from './types';
import { gridAgent } from './agents/grid';
import { healthFactorAgent } from './agents/health-factor';
import { yieldAgent } from './agents/yield';
import { lpRangeAgent } from './agents/lp-range';

const ALL: AgentModule[] = [gridAgent, healthFactorAgent, yieldAgent, lpRangeAgent];
const PORT = Number(process.env.AGENTS_PORT ?? 4410);

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
  startX402Server({ port: PORT, facilitatorKey: privateKey, agents });
  console.log(`x402 status server on :${PORT} (${[...agents.keys()].join(', ')})`);

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
