/**
 * Agent manifest bodies, served by /manifests/<slug>.json.
 *
 * These were four static files under public/manifests. The on-chain ERC-8004
 * tokenURIs point at those exact paths and are permanent, so the paths and the
 * bodies must stay as they were; the only value that changes is
 * x402.endpoint, which is injected per request from the runner resolver
 * instead of being frozen into a committed file at tunnel-rotation time.
 *
 * Key order below mirrors the original JSON so the served bodies are
 * byte-compatible with what the registered tokenURIs already resolved to.
 */

/** `safety` mixes numeric limits with allowlists (health-factor's `actions`). */
export type SafetyValue = number | string[];

export interface ManifestExecution {
  venue?: string;
  rebalanceVenue?: string;
  protocol?: string;
  asset?: string;
  pair?: string;
  chainId: number;
}

export interface Manifest {
  name: string;
  description: string;
  category: string;
  image: string;
  capabilities: string[];
  execution: ManifestExecution;
  safety: Record<string, SafetyValue>;
  /** Present only on the session-key agents; omitted elsewhere, as before. */
  recommendedScope?: { spendCapUsdtPerDay: string; expiresHours: number };
  x402: { endpoint: string; priceUsdt: string; note: string };
}

type ManifestBase = Omit<Manifest, 'x402'> & { x402: Omit<Manifest['x402'], 'endpoint'> };

const BASE: Record<string, ManifestBase> = {
  grid: {
    name: 'Agripinaa Grid',
    description:
      'Mean-reversion grid trader on the WBNB/USDT pair. Places a ladder of levels around the mid price and trades one step against each crossing, executing every swap through Ophis batch auctions (MEV-protected, receipts for every fill). Halts itself on trend breakouts and daily loss limits.',
    category: 'grid',
    image: 'https://agripinaa.vercel.app/agent-icon.png',
    capabilities: ['trading', 'x402-status'],
    execution: { venue: 'ophis', pair: 'WBNB/USDT', chainId: 56 },
    safety: { maxTradesPerDay: 12, perTradeClipUsd: 2, lossHaltPct: 5, trendHaltBandPct: 6 },
    x402: { priceUsdt: '0.05', note: 'live' },
  },
  'health-factor': {
    name: 'Agripinaa Guardian',
    description:
      "Liquidation protection for lending positions. Watches the position's health factor around the clock and repays debt from a pre-approved budget through an Altana session key (contract allowlist, daily spend cap, expiry) before liquidation can trigger. Repay and supply only: it can never borrow or withdraw.",
    category: 'health-factor',
    image: 'https://agripinaa.vercel.app/agent-icon.png',
    capabilities: ['session-keys', 'monitoring', 'x402-status'],
    execution: { protocol: 'lending', chainId: 56 },
    safety: { actions: ['repay', 'supply'], warnHF: 1.5, actHF: 1.3, targetHF: 1.6 },
    recommendedScope: { spendCapUsdtPerDay: '25', expiresHours: 168 },
    x402: { priceUsdt: '0.05', note: 'live' },
  },
  yield: {
    name: 'Agripinaa Harvester',
    description:
      'Stablecoin yield rotation across BSC lending venues. Compares live supply rates and moves deposits only when the better venue wins by more than 50 bps on two consecutive checks (no churn on noise). Same asset in, same asset out, venue allowlist enforced.',
    category: 'yield',
    image: 'https://agripinaa.vercel.app/agent-icon.png',
    capabilities: ['session-keys', 'x402-status'],
    execution: { asset: 'USDT', chainId: 56 },
    safety: { maxMovesPerDay: 1, hysteresisBps: 50, confirmations: 2 },
    x402: { priceUsdt: '0.05', note: 'live' },
  },
  'lp-range': {
    name: 'Agripinaa Ranger',
    description:
      'Concentrated-liquidity range management on PancakeSwap V3 (WBNB/USDT). Detects when the position drifts out of range, collects and closes it, rebalances inventory 50/50 through an Ophis batch auction, and re-mints a fresh range around the current tick. Fee-bleed guard caps rebalances per day and week.',
    category: 'rebalancing',
    image: 'https://agripinaa.vercel.app/agent-icon.png',
    capabilities: ['trading', 'lp-management', 'x402-status'],
    execution: {
      venue: 'pancakeswap-v3',
      rebalanceVenue: 'ophis',
      pair: 'WBNB/USDT',
      chainId: 56,
    },
    safety: {
      rangePct: 5,
      outOfRangeMinutes: 30,
      maxRebalancesPerDay: 2,
      maxRebalancesPerWeek: 4,
    },
    x402: { priceUsdt: '0.05', note: 'live' },
  },
};

export const MANIFEST_SLUGS = Object.keys(BASE);

export function buildManifest(slug: string, runnerBase: string): Manifest | null {
  const base = BASE[slug];
  if (!base) return null;
  return {
    ...base,
    // `endpoint` first, then the rest, so the x402 key order matches the
    // original files.
    x402: { endpoint: new URL(`/${slug}/status`, runnerBase).toString(), ...base.x402 },
  };
}
