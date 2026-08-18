import type { AgentModule } from '../types';

/** Placeholder: replaced by the real yield strategy (week-3B build). */
export const yieldAgent: AgentModule = {
  name: 'yield',
  category: 'yield',
  tickIntervalMs: 60_000,
  async tick(ctx) {
    ctx.log({ event: 'noop-tick' });
  },
  async status() {
    return { implemented: false };
  },
};
