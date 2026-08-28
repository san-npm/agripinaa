import type { AgentSlug } from './agents';

/** The four assets a user may send to start any first-party strategy. */
export const FUNDING_ASSETS = ['BTCB', 'BNB', 'USDT', 'USDC'] as const;
export type FundingAsset = (typeof FUNDING_ASSETS)[number];
export type FundingToken = Exclude<FundingAsset, 'BNB'> | 'WBNB';

/**
 * Native BNB left in the user's account after bootstrap. It remains the
 * user's property and pays later scoped agent executions.
 */
export const FUNDING_GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 BNB

/** Two registrations are needed for a new managed account: admin + session. */
export const FUNDING_REGISTRATION_COUNT = 2n;
/** Refuse activation instead of draining capital if the live KeyStore fee spikes. */
export const FUNDING_MAX_REGISTRATION_FEE_WEI = 2_000_000_000_000_000n; // 0.002 BNB

/**
 * Published bootstrap budget. For a native deposit it stays available to pay
 * the first account operation. For an ERC-20 deposit the merchant fee payer
 * advances that operation; a disclosed slice of the deposit is swapped and
 * unwrapped into at least this much native BNB in a signed pre-call. Ithaca's
 * orchestrator preserves that pre-call and the fee payment when a later
 * account call reverts, so failed strategy preparation is not subsidized.
 */
export const FUNDING_BOOTSTRAP_FEE_WEI = 200_000_000_000_000n; // 0.0002 BNB

/** Input padding protects an exact gas-reserve output from a small price move. */
export const FUNDING_QUOTE_BUFFER_BPS = 200n;
/** Every strategy-capital swap has a non-zero one-percent minimum output. */
export const FUNDING_MAX_SLIPPAGE_BPS = 100n;
export const BPS_DENOMINATOR = 10_000n;

/** Canonical PancakeSwap V3 deployments on BNB Chain. */
export const PANCAKE_V3_FACTORY_BSC =
  '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as const;
export const PANCAKE_V3_SMART_ROUTER_BSC =
  '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' as const;
export const PANCAKE_V3_QUOTER_V2_BSC =
  '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997' as const;

/**
 * Public address that signs Altana's fee-payer digest and receives the
 * disclosed native-BNB bootstrap reimbursement. The private key stays in the
 * gitignored facilitator wallet on the runner.
 */
export const FUNDING_FEE_PAYER_BSC =
  '0x7f922FB740E2036477346f559e5660fA38A2C9E5' as const;

/** Live Altana/Ithaca orchestrator whose signed pre-call semantics we rely on. */
export const ALTANA_ORCHESTRATOR_BSC =
  '0xaf140d0416a994aebb3fa6212b16ce6700f09751' as const;
export const ALTANA_ORCHESTRATOR_VERSION_BSC = '0.5.5' as const;

/** Altana BNB KeyStore controller, needed only on a passkey account's first call. */
export const ALTANA_KEYSTORE_CONTROLLER_BSC =
  '0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555' as const;

export interface FundingRoute {
  tokens: readonly FundingToken[];
  fees: readonly number[];
}

const EDGES: Readonly<Record<FundingToken, readonly { token: FundingToken; fee: number }[]>> = {
  WBNB: [
    { token: 'USDT', fee: 100 },
    { token: 'BTCB', fee: 500 },
  ],
  USDT: [
    { token: 'WBNB', fee: 100 },
    { token: 'USDC', fee: 100 },
  ],
  USDC: [{ token: 'USDT', fee: 100 }],
  BTCB: [{ token: 'WBNB', fee: 500 }],
};

/** Shortest pinned-liquid route between any two supported ERC-20 assets. */
export function fundingRoute(source: FundingToken, target: FundingToken): FundingRoute {
  if (source === target) return { tokens: [source], fees: [] };
  const queue: { token: FundingToken; tokens: FundingToken[]; fees: number[] }[] = [
    { token: source, tokens: [source], fees: [] },
  ];
  const seen = new Set<FundingToken>([source]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of EDGES[current.token]) {
      if (seen.has(edge.token)) continue;
      const next = {
        token: edge.token,
        tokens: [...current.tokens, edge.token],
        fees: [...current.fees, edge.fee],
      };
      if (edge.token === target) return { tokens: next.tokens, fees: next.fees };
      seen.add(edge.token);
      queue.push(next);
    }
  }
  throw new Error(`no funding route from ${source} to ${target}`);
}

/**
 * Output inventory prepared by the owner before the scoped mandate begins.
 * Pair strategies receive both legs immediately; guardians receive USDT;
 * yield strategies keep USDC deposits as USDC and normalize every other
 * input to USDT.
 */
export function fundingTargetsForAgent(
  agent: AgentSlug,
  input: FundingAsset,
): readonly FundingToken[] {
  switch (agent) {
    case 'grid':
    case 'lp-range':
    case 'weight-rebalancer':
      return ['WBNB', 'USDT'];
    case 'grid-b':
      return ['BTCB', 'USDT'];
    case 'health-factor':
    case 'venus-guardian':
      return ['USDT'];
    case 'yield':
    case 'yield-b':
      return [input === 'USDC' ? 'USDC' : 'USDT'];
  }
}

export function managedTokenForFunding(agent: AgentSlug, input: FundingAsset): 'USDT' | 'USDC' {
  const targets = fundingTargetsForAgent(agent, input);
  return targets.length === 1 && targets[0] === 'USDC' ? 'USDC' : 'USDT';
}

export function withFundingQuoteBuffer(value: bigint): bigint {
  return (value * (BPS_DENOMINATOR + FUNDING_QUOTE_BUFFER_BPS) + BPS_DENOMINATOR - 1n)
    / BPS_DENOMINATOR;
}

export function withFundingSlippage(value: bigint): bigint {
  return value * (BPS_DENOMINATOR - FUNDING_MAX_SLIPPAGE_BPS) / BPS_DENOMINATOR;
}

export function isFundingAsset(value: unknown): value is FundingAsset {
  return typeof value === 'string' && (FUNDING_ASSETS as readonly string[]).includes(value);
}
