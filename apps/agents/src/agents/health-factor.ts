import type { AgentModule } from '../types';

/** Placeholder: replaced by the real health-factor strategy (week-3B build). */
export const healthFactorAgent: AgentModule = {
  name: 'health-factor',
  category: 'health-factor',
  tickIntervalMs: 60_000,
  async tick(ctx) {
    ctx.log({ event: 'noop-tick' });
  },
  async status() {
    return { implemented: false };
  },
};
