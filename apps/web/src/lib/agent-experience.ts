import type { AgentSlug } from '@agripinaa/shared/agents';

export interface ManagedActivationCopy {
  heading: string;
  intro: string;
  submitLabel: string;
  activeSummary: string;
}

export interface AgentExperienceCopy {
  /** Compact positioning shown on the directory card. */
  directoryLabel: string;
  /** Primary action on the profile. Autonomous agents jump to their live x402 interaction. */
  profileCta: string;
  /** Present only when this agent can consume a user mandate. */
  managed?: ManagedActivationCopy;
}

/**
 * Hackathon-facing positioning for every first-party agent.
 *
 * Every first-party agent accepts a public mandate. Copy names the concrete
 * strategy a user activates; Harvester and Steward remain deliberately
 * different yield policies rather than two copies of one generic action.
 */
export const AGENT_EXPERIENCE: Record<AgentSlug, AgentExperienceCopy> = {
  grid: {
    directoryLabel: 'WBNB grid · managed strategy',
    profileCta: 'Activate WBNB grid',
    managed: {
      heading: 'Run the WBNB mean-reversion grid',
      intro: 'Fund a dedicated passkey account once with BTCB, BNB, USDT, or USDC. Grid prepares its WBNB and USDT legs, trades $2 ladder clips through Ophis, and enforces its cooldown, daily action cap, breakout halt, and drawdown floor per account.',
      submitLabel: 'Start WBNB grid',
      activeSummary: 'Grid is now watching the WBNB/USDT ladder and will submit bounded Ophis orders when a level crosses.',
    },
  },
  'grid-b': {
    directoryLabel: 'BTCB grid · managed strategy',
    profileCta: 'Activate BTC grid',
    managed: {
      heading: 'Run the patient BTCB grid',
      intro: 'Fund once with BTCB, BNB, USDT, or USDC. The account prepares both grid legs, then BTC Grid runs its wider 2.5% ladder and slower cooldown through Ophis.',
      submitLabel: 'Start BTCB grid',
      activeSummary: 'BTC Grid is now watching its wider BTCB/USDT ladder and will trade bounded clips through Ophis.',
    },
  },
  'health-factor': {
    directoryLabel: 'Aave protection · managed reserve',
    profileCta: 'Protect Aave position',
    managed: {
      heading: 'Guard an Aave borrowing position',
      intro: 'Connect the passkey account that owns your Aave position and fund once with BTCB, BNB, USDT, or USDC. The deposit becomes a USDT repair reserve; Guardian can only call Aave repay under the published cap.',
      submitLabel: 'Start Aave protection',
      activeSummary: 'Guardian is now monitoring this account’s Aave health factor and can deploy its USDT repair reserve when the action threshold is crossed.',
    },
  },
  'venus-guardian': {
    directoryLabel: 'Venus protection · managed reserve',
    profileCta: 'Protect Venus position',
    managed: {
      heading: 'Guard a Venus borrowing position',
      intro: 'Connect the passkey account that owns your Venus position and fund once with BTCB, BNB, USDT, or USDC. The deposit becomes a USDT repair reserve; Venus Guardian can only call repayBorrow.',
      submitLabel: 'Start Venus protection',
      activeSummary: 'Venus Guardian is now monitoring this account’s Venus health factor and can deploy its USDT repair reserve at the action threshold.',
    },
  },
  yield: {
    directoryLabel: 'Responsive yield · managed deposits',
    profileCta: 'Choose responsive yield',
    managed: {
      heading: 'Capture yield changes sooner',
      intro:
        'Harvester moves when a 50 bps rate advantage survives two checks. Choose it when responding to smaller yield opportunities matters more than minimizing rotations.',
      submitLabel: 'Start responsive yield',
      activeSummary:
        'Harvester now follows its responsive policy for your deposit: a 50 bps edge must hold for two checks before it rotates between Venus and Aave.',
    },
  },
  'yield-b': {
    directoryLabel: 'Patient yield · managed deposits',
    profileCta: 'Choose patient yield',
    managed: {
      heading: 'Wait for stronger yield signals',
      intro:
        'Steward waits for a 120 bps advantage across three twelve-hour checks and keeps at least 48 hours between rotations. Choose it when lower churn matters more than reacting quickly.',
      submitLabel: 'Start patient yield',
      activeSummary:
        'Steward now follows its patient policy for your deposit: a 120 bps edge must persist across three twelve-hour checks, with at least 48 hours between rotations.',
    },
  },
  'lp-range': {
    directoryLabel: 'PancakeSwap V3 range · managed LP',
    profileCta: 'Activate LP Ranger',
    managed: {
      heading: 'Run a managed Pancake V3 range',
      intro: 'Fund once with BTCB, BNB, USDT, or USDC. The account prepares WBNB and USDT, then LP Ranger mints a ±5% position and uses Ophis when inventory needs balancing.',
      submitLabel: 'Start LP Ranger',
      activeSummary: 'LP Ranger now owns the range lifecycle for this dedicated account under its weekly rebalance and daily action limits.',
    },
  },
  'weight-rebalancer': {
    directoryLabel: '50/50 portfolio · managed strategy',
    profileCta: 'Activate 50/50 rebalancer',
    managed: {
      heading: 'Keep WBNB and USDT near 50/50',
      intro: 'Fund once with BTCB, BNB, USDT, or USDC. The account prepares WBNB and USDT, then Rebalancer acts only outside its five-point drift band.',
      submitLabel: 'Start 50/50 rebalancing',
      activeSummary: 'Rebalancer is now monitoring this account’s WBNB/USDT weights and will act only outside the published drift band.',
    },
  },
};

export function agentExperience(slug: AgentSlug): AgentExperienceCopy {
  return AGENT_EXPERIENCE[slug];
}
