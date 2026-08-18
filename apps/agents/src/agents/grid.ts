import type { AgentModule } from '../types';

/** Placeholder: replaced by the real grid strategy (week-3B build). */
export const gridAgent: AgentModule = {
  name: 'grid',
  category: 'grid',
  tickIntervalMs: 60_000,
  async tick(ctx) {
    ctx.log({ event: 'noop-tick' });
  },
  async status() {
    return { implemented: false };
  },
};
