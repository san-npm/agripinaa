import { AGENTS, type AgentSlug } from '@agripinaa/shared/agents';
import { fromBaseUnits, TOKENS_BSC } from '@agripinaa/shared/tokens';

import type { StatusEndpointAnswer } from './x402-status';

/**
 * The pure half of the x402 panel: reading a 402 challenge into something a
 * page can show, and the example payload a hirer sees before paying. No
 * network, no window, no server-only imports, so both the client component
 * and the tests use it as-is.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_RE = /^\d+$/;

/** What a 402 challenge asks for, reduced to the fields a person pays against. */
export interface X402Ask {
  description: string | null;
  /** Atomic token units, exactly as the challenge states them. */
  amount: string;
  /** "0.05 USDT" for a registry token; the atomic figure otherwise. */
  amountFormatted: string;
  asset: `0x${string}`;
  assetSymbol: string | null;
  payTo: `0x${string}`;
  /** CAIP-2, e.g. "eip155:56". */
  network: string;
  chainId: number | null;
  /** "permit2-exact" or "eip3009" on the B402 wire; null when the option has neither. */
  rail: string | null;
  /** The settler bound as Permit2 spender, when the rail has one. */
  spender: `0x${string}` | null;
  timeoutSeconds: number | null;
}

const SYMBOL_BY_ADDRESS = new Map(
  Object.values(TOKENS_BSC).map((token) => [token.address.toLowerCase(), token]),
);

function address(value: unknown): `0x${string}` | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? (value as `0x${string}`) : null;
}

function readOption(candidate: unknown): X402Ask | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const row = candidate as Record<string, unknown>;
  const asset = address(row.asset);
  const payTo = address(row.payTo);
  // Both field names are on the wire: `amount` is B402 v2, `maxAmountRequired`
  // the legacy dialect the Altana SDK still accepts.
  const rawAmount = typeof row.amount === 'string' ? row.amount : row.maxAmountRequired;
  const amount = typeof rawAmount === 'string' && ATOMIC_RE.test(rawAmount) ? rawAmount : null;
  const network = typeof row.network === 'string' ? row.network : null;
  if (!asset || !payTo || !amount || !network) return null;

  const extra = row.extra && typeof row.extra === 'object' ? (row.extra as Record<string, unknown>) : {};
  const token = SYMBOL_BY_ADDRESS.get(asset.toLowerCase());
  const chain = /^eip155:(\d+)$/.exec(network);
  const timeout = row.maxTimeoutSeconds;
  return {
    description: null,
    amount,
    amountFormatted: token
      ? `${fromBaseUnits(BigInt(amount), token.decimals)} ${token.symbol}`
      : `${amount} (atomic units)`,
    asset,
    assetSymbol: token?.symbol ?? null,
    payTo,
    network,
    chainId: chain ? Number.parseInt(chain[1]!, 10) : null,
    rail: typeof extra.assetTransferMethod === 'string' ? extra.assetTransferMethod : null,
    spender: address(extra.spenderAddress) ?? address(extra.spender),
    timeoutSeconds: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
  };
}

/**
 * Read an x402 402 body into one payment option. Prefers permit2-exact, the
 * rail an Altana session pays (an ERC-1271 smart-account signature verifies
 * on-chain for any Permit2-approved token), and otherwise takes the first
 * option that is whole. The body comes off the tunnel, so nothing in it is
 * trusted until it parses: a malformed address or amount makes the whole
 * challenge null rather than a partly rendered one.
 */
export function decodeChallenge(body: unknown): X402Ask | null {
  if (!body || typeof body !== 'object') return null;
  const { accepts, description } = body as { accepts?: unknown; description?: unknown };
  if (!Array.isArray(accepts)) return null;
  const options = accepts.map(readOption).filter((option): option is X402Ask => option !== null);
  const chosen = options.find((option) => option.rail === 'permit2-exact') ?? options[0];
  if (!chosen) return null;
  return { ...chosen, description: typeof description === 'string' ? description : null };
}

/**
 * What the panel shows for one answer, before the challenge is matched against
 * what this browser has stored. Pure, so every state the panel can land in is
 * reachable from a test rather than only from a click.
 */
export type StatusVerdict =
  | { kind: 'challenge'; ask: X402Ask }
  | { kind: 'paid'; payload: unknown }
  /** No answer: a dead tunnel, a refused redirect, a timeout on either side. */
  | { kind: 'offline' }
  | { kind: 'unexpected'; detail: string };

/**
 * Read one answer from the status endpoint into the state the panel renders.
 *
 * Every branch ends in a state that says something. In particular a 2xx whose
 * body did not parse is an error rather than a success with nothing in it: the
 * server function passes an unreadable body on as null, and printing that in
 * the paid panel would read as the runner answering with nothing.
 */
export function readStatusAnswer(
  answer: StatusEndpointAnswer | { kind: 'timeout' },
): StatusVerdict {
  switch (answer.kind) {
    case 'unreachable':
    case 'timeout':
      return { kind: 'offline' };
    case 'oversized':
      return { kind: 'unexpected', detail: 'The runner answered with a body larger than a status can be.' };
    case 'unknown-agent':
      return { kind: 'unexpected', detail: 'This agent is not in the registry the server holds.' };
    case 'answered':
      break;
  }
  if (answer.status === 402) {
    const ask = decodeChallenge(answer.body);
    return ask
      ? { kind: 'challenge', ask }
      : { kind: 'unexpected', detail: 'The runner answered 402 with a challenge this page could not read.' };
  }
  if (answer.status >= 200 && answer.status < 300) {
    return answer.body == null
      ? {
          kind: 'unexpected',
          detail: `The runner answered ${answer.status} with a body this page could not read as JSON.`,
        }
      : { kind: 'paid', payload: answer.body };
  }
  return { kind: 'unexpected', detail: `The runner answered ${answer.status}.` };
}

/** Where a challenge's payment goes, judged against the committed registry. */
export type PayToCheck =
  /** The challenge pays the wallet the registry commits for this agent. */
  | { verdict: 'pinned'; wallet: `0x${string}` }
  /** The challenge pays somewhere else: what a replaced runner base would produce. */
  | { verdict: 'mismatch'; expected: `0x${string}`; reported: `0x${string}` }
  /** The registry holds no wallet for this agent, so nothing can vouch for the destination. */
  | { verdict: 'unpinned'; reported: `0x${string}` };

/**
 * Pin the challenge's payTo to AGENTS[slug].wallet. The 402 body comes off a
 * rotating quick-tunnel hostname, and a dead name could be re-issued to
 * someone else, so the address it asks to be paid at is the point where a
 * hijacked base would be paid; the same reasoning as the manager-key pin
 * (packages/shared/src/agents.ts, managerKeys). Unlike that pin, an agent with
 * no wallet yet is closed rather than accepted with a warning: a missing key
 * only delays activation, whereas a payment sent to an unvouched address is
 * gone. Case-insensitive because the wire may checksum and the registry may
 * not.
 */
export function checkPayTo(slug: AgentSlug, reported: `0x${string}`): PayToCheck {
  const wallet = AGENTS[slug].wallet;
  if (!wallet) return { verdict: 'unpinned', reported };
  if (wallet.toLowerCase() !== reported.toLowerCase()) {
    return { verdict: 'mismatch', expected: wallet, reported };
  }
  return { verdict: 'pinned', wallet };
}

/** Human label for a CAIP-2 network the challenge names. */
export function networkLabel(ask: Pick<X402Ask, 'network' | 'chainId'>): string {
  if (ask.chainId === 56) return 'BNB Smart Chain (56)';
  if (ask.chainId === 97) return 'BSC Testnet (97)';
  return ask.network;
}

/**
 * Example `status` bodies, one per agent, mirroring the keys each module's
 * status() returns (apps/agents/src/agents/<slug>.ts). Values are
 * illustrative; the panel labels them as such. tests/x402-demo.test.ts pins the
 * key lists of the registered agents against a reading of those bodies.
 */
const STATUS_PREVIEW: Record<AgentSlug, Record<string, unknown>> = {
  grid: {
    center: 612.4,
    price: 615.1,
    levels: [{ price: 600.2, side: 'buy', crossed: false }],
    fills: [
      {
        at: '2026-08-25T12:00:00.000Z',
        side: 'sell',
        level: '624.6',
        clipToken: 'WBNB',
        clipAmount: '0.01',
        price: 624.9,
        orderUid: '0x<ophis order uid>',
      },
    ],
    inventoryStartUsd: 250,
    inventoryNowUsd: 251.3,
    halted: { halted: false },
  },
  'grid-b': {
    pair: 'BTCB/USDT',
    params: { pair: 'BTCB/USDT', spacingPct: 2.5, levelsPerSide: 5 },
    center: 64210,
    price: 64388,
    levels: [{ price: 62605, side: 'buy', crossed: false }],
    fills: [],
    inventoryStartUsd: 250,
    inventoryNowUsd: 250.8,
    halted: { halted: false },
  },
  'health-factor': {
    healthFactor: 1.82,
    warnAt: 1.5,
    actAt: 1.3,
    targetAfterRepair: 1.6,
    collateralBase: '245000000',
    debtBase: '80000000',
    repayBudgetUsdt: '0.75',
    actionsToday: 0,
    halted: false,
  },
  'venus-guardian': {
    protocol: 'venus',
    healthFactor: 1.91,
    warnAt: 1.5,
    actAt: 1.3,
    targetAfterRepair: 1.6,
    collateralUsd: '2.45',
    debtUsd: '0.8',
    usdtDebt: '0.8',
    collateralFactor: '800000000000000000',
    marketsEntered: 1,
    shortfallUsd: '0',
    repayBudgetUsdt: '0.75',
    maxRepaysPerDay: 3,
    actionsToday: 0,
    halted: false,
  },
  yield: {
    venue: 'venus',
    positionUsdt: '0.99',
    venusApyBps: 412,
    aaveApyBps: 388,
    edgeBps: -24,
    betterStreak: 0,
    movesToday: 0,
    halted: false,
  },
  'yield-b': {
    venue: 'aave',
    positionUsdt: '0.99',
    venusApyBps: 412,
    aaveApyBps: 388,
    edgeBps: 24,
    thresholdBps: 100,
    requiredWins: 3,
    minHoursBetweenMoves: 48,
    betterStreak: 1,
    hoursSinceLastMove: 71.5,
    movesToday: 0,
    halted: false,
  },
  'lp-range': {
    tokenId: 1234567,
    tickLower: -63980,
    tickUpper: -63740,
    currentTick: -63855,
    inRange: true,
    outSinceMinutes: null,
    rebalancesToday: 0,
    rebalancesThisWeek: 1,
    inventoryPrepsThisWeek: 0,
    weeklyBudgetUsed: 1,
    weeklyBudgetMax: 4,
    halted: false,
  },
  'weight-rebalancer': {
    pair: 'WBNB/USDT',
    targetWeight: 0.5,
    bandPct: 5,
    weight: 0.52,
    driftPoints: 2,
    price: 615.1,
    totalUsd: 250.6,
    maxRebalancesPerDay: 4,
    cooldownMinutes: 35,
    lastRebalanceAt: '2026-08-25T09:10:00.000Z',
    rebalances: [],
    halted: { halted: false },
  },
};

/** The envelope x402-server writes once a payment has settled, with an example status inside. */
export interface X402PreviewPayload {
  agent: AgentSlug;
  category: string;
  paidBy: string;
  settlementTx: string;
  status: Record<string, unknown>;
}

export function previewPayload(slug: AgentSlug): X402PreviewPayload {
  return {
    agent: slug,
    category: AGENTS[slug].category,
    paidBy: '0x<your address>',
    settlementTx: '0x<bsc settlement tx>',
    status: STATUS_PREVIEW[slug],
  };
}
