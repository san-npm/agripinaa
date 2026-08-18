import type { AgentModule } from '../types';

/** Placeholder: replaced by the real lp-range strategy (week-3B build). */
export const lpRangeAgent: AgentModule = {
  name: 'lp-range',
  category: 'rebalancing',
  tickIntervalMs: 60_000,
  async tick(ctx) {
    ctx.log({ event: 'noop-tick' });
  },
  async status() {
    return { implemented: false };
  },
};
