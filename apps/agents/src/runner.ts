/**
 * Agent runner: one long-lived process hosting every agent's tick loop plus
 * the shared x402 status server. Overlap-guarded intervals, exponential
 * error backoff per agent, breakers respected before every tick.
 *
 * Usage: pnpm --filter @agripinaa/agents start [-- --only grid,yield]
 */
import { readFileSync } from 'node:fs';
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

async function main() {
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
