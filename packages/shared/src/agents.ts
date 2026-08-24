/**
 * THE registry of first-party Agripinaa agents: one record per agent, holding
 * every piece of per-agent identity the monorepo needs.
 *
 * Before this file, an agent's slug, token id, wallet, manifest body, funding
 * plan, registration tx, attestation, and execution proofs were hand-maintained
 * across at least eight places (runner.ts, fund.ts, register.ts, attest.ts,
 * data.ts, verified.ts, manifests.ts, proof.ts). None of them cross-check, so
 * missing one edit left a new agent half-wired with no error at all: it would
 * tick but never appear in the proof feed, or appear on the marketplace with no
 * runner behind it. Consolidating is the precondition for adding agents safely.
 *
 * Two rules for editing this file:
 *
 * 1. `manifest` is byte-sensitive. Each agent's manifest is served at
 *    /manifests/<slug>.json, which is the tokenURI of an already-minted,
 *    immutable ERC-8004 identity. The served bytes must not change: not a
 *    value, not a key, not the ORDER of the keys, since the body is
 *    JSON.stringify'd in declaration order. tests/agents.test.ts pins the exact
 *    bytes of all four.
 * 2. `wallet` is the agent's PUBLIC address. Signer secrets live only in
 *    wallets/*.json and are never read here.
 *
 * `tokenId` is nullable so an agent can exist in config, be funded, and be
 * tested before it is registered on-chain.
 */

export type AgentSlug = 'grid' | 'health-factor' | 'yield' | 'lp-range';

/** Marketplace category. Matches @agripinaa/agent-index's `Category`. */
export type AgentCategory = 'grid' | 'health-factor' | 'yield' | 'rebalancing';

/** `safety` mixes numeric limits with allowlists (health-factor's `actions`). */
export type SafetyValue = number | string[];

/** Execution shape varies per agent; only `chainId` is common to all four. */
export interface ManifestExecution {
  venue?: string;
  rebalanceVenue?: string;
  protocol?: string;
  asset?: string;
  pair?: string;
  chainId: number;
}

/**
 * An agent manifest minus `x402.endpoint`, which the web app injects per
 * request from the live runner base (the tunnel URL rotates; the manifest
 * body does not).
 */
export interface ManifestBase {
  name: string;
  description: string;
  category: string;
  image: string;
  capabilities: string[];
  execution: ManifestExecution;
  safety: Record<string, SafetyValue>;
  /** Present only on the session-key agents; omitted elsewhere. */
  recommendedScope?: { spendCapUsdtPerDay: string; expiresHours: number };
  x402: { priceUsdt: string; note: string };
}

export interface ExecutionProof {
  label: string;
  /** BscScan tx hash, or a token id for an NFT position. */
  ref: string;
  kind: 'tx' | 'position';
  note: string;
}

/** The on-chain ERC-8004 ReputationRegistry attestation from our verifier. */
export interface AgentAttestation {
  txHash: string;
  verifier: string;
  tag: string;
  feedbackHash: string;
}

/** One-time funding transfer sizes, in whole units. */
export interface AgentFunding {
  bnb: string;
  usdt?: string;
  usdc?: string;
  wbnb?: string;
}

export interface AgentRecord {
  slug: AgentSlug;
  /** ERC-8004 token id on BSC mainnet, or null before registration. */
  tokenId: string | null;
  name: string;
  category: AgentCategory;
  /** The agent's public wallet: what it trades from, never a signer secret. */
  wallet: `0x${string}`;
  /** File under wallets/ holding this agent's own-capital key. */
  walletFile: string;
  /** Can manage user funds through a scoped session key on a router. */
  managed: boolean;
  /** Whether to backfill this wallet's Ophis settlements into the proof feed. */
  backfillOphisTrades: boolean;
  manifest: ManifestBase;
  funding: AgentFunding;
  registrationTx: string | null;
  attestation: AgentAttestation | null;
  proofs: ExecutionProof[];
}

/** The wallet that writes our ReputationRegistry attestations. */
const VERIFIER = '0x80c545ef426aa9e46543E5ac2BA4B9728CeB58A1';

export const AGENTS: Record<AgentSlug, AgentRecord> = {
  grid: {
    slug: 'grid',
    tokenId: '269703',
    name: 'Agripinaa Grid',
    category: 'grid',
    wallet: '0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A',
    walletFile: 'agent-grid.json',
    managed: false,
    backfillOphisTrades: true,
    manifest: {
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
    funding: { bnb: '0.0011', usdt: '5', wbnb: '0.004' },
    registrationTx: '0x8fceeefa8bdf6796251b39ce2f8530ba68a84116ead0edf6277fe09e847b2b4b',
    attestation: {
      txHash: '0xe68fa1443f7bcc785435a17cec3e8809d05b3854451dc78a815b356d6e89b61f',
      verifier: VERIFIER,
      tag: 'agripinaa-verified · grid',
      feedbackHash: 'anchored to the Ophis order below',
    },
    proofs: [
      {
        label: 'Ophis order filled',
        ref: '0xa2fa52fa97922df8b884345a2959a71209a73957073098c4af76cbd72fa1f02b053fff26d28ff4e94dfe862b184f918a50c6f7066a848e4c',
        kind: 'tx',
        note: 'WBNB → USDT via batch auction, +48.61 bps surplus vs signed limit',
      },
    ],
  },
  'health-factor': {
    slug: 'health-factor',
    tokenId: '269704',
    name: 'Agripinaa Guardian',
    category: 'health-factor',
    wallet: '0x7d2dCB4eD1a90B992B34C114C924c5643B461DFF',
    walletFile: 'agent-health-factor.json',
    managed: false,
    backfillOphisTrades: false,
    manifest: {
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
    funding: { bnb: '0.0011', usdt: '2', wbnb: '0.005' },
    registrationTx: '0x60644577f63a2d5b49136de8507ff4b1e1dd0233d0dec247ae592b09630d310b',
    attestation: {
      txHash: '0x3338e7083743cef92336bf38459bc3e67a733f3c2df764c6ea7012389e6c29b8',
      verifier: VERIFIER,
      tag: 'agripinaa-verified · health-factor',
      feedbackHash: 'anchored to the liquidation-drill repay below',
    },
    proofs: [
      {
        label: 'Liquidation drill: autonomous repay',
        ref: '0x367cb2dc8ab49a0960077ac0e30b58c2d200bc21ecc2bf184c367050b4b0050a',
        kind: 'tx',
        note: 'HF pushed to 1.25, agent repaid to 1.60 in ~62s, unattended',
      },
    ],
  },
  yield: {
    slug: 'yield',
    tokenId: '269705',
    name: 'Agripinaa Harvester',
    category: 'yield',
    wallet: '0x344eF980A827e9FF4086Ee95b22aeD0D95d11ac9',
    walletFile: 'agent-yield.json',
    managed: true,
    backfillOphisTrades: false,
    manifest: {
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
    funding: { bnb: '0.0009', usdt: '2.5', wbnb: '0' },
    registrationTx: '0xe1635838277c5a37bec53e9f2e76c5f4e8d4324b1e49f3e48992688f7adefe02',
    attestation: {
      txHash: '0x10005a89f8bde342947866f972f544bd4376681f8f8bdcec3564366e16f9adc4',
      verifier: VERIFIER,
      tag: 'agripinaa-verified · yield',
      feedbackHash: 'anchored to the Aave supply below',
    },
    proofs: [
      {
        label: 'Rate-picked supply on Aave V3',
        ref: '0xefa6d0840e9974fdd28700116f152d054e3c5f178417e36d06f85399a30e058f',
        kind: 'tx',
        note: 'Read Venus 202 bps vs Aave 207 bps on-chain, supplied to the winner',
      },
    ],
  },
  'lp-range': {
    slug: 'lp-range',
    tokenId: '269706',
    name: 'Agripinaa Ranger',
    // The Ranger's manifest category is `rebalancing`, not its slug. Slug and
    // category are separate axes; do not assume they match.
    category: 'rebalancing',
    wallet: '0x79827EF1faDeA3B30A8E77fdbaF17944298A3bB6',
    walletFile: 'agent-lp-range.json',
    managed: false,
    backfillOphisTrades: true,
    manifest: {
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
    funding: { bnb: '0.0011', usdt: '1.5', wbnb: '0.003' },
    registrationTx: '0x8c417a60a0733ea8c94e3dd7d6b7e9d045651b7f4aff6713429242f6432c7e01',
    attestation: {
      txHash: '0x89a33aa7661447b2d73e8ac69e78f2db11c86e4992b6558db3118dbeab1fdd82',
      verifier: VERIFIER,
      tag: 'agripinaa-verified · rebalancing',
      feedbackHash: 'anchored to the V3 position below',
    },
    // STALE, carried verbatim from verified.ts rather than silently corrected:
    // position 7173629 reads liquidity = 0 on-chain as of 2026-08-24 because the
    // agent rebalanced out of it; its live position is 7248592. Task 12's proof
    // harvest is what should refresh this ref (and the attestation anchored to
    // it), not a hand edit here.
    proofs: [
      {
        label: 'PancakeSwap V3 position minted',
        ref: '7173629',
        kind: 'position',
        note: 'Concentrated-liquidity WBNB/USDT position, managed in range',
      },
    ],
  },
};

export const AGENT_LIST: AgentRecord[] = Object.values(AGENTS);

/** Undefined for any slug that is not a first-party agent. */
export function agentBySlug(slug: string): AgentRecord | undefined {
  return (AGENTS as Record<string, AgentRecord | undefined>)[slug];
}

/** Undefined before an agent is registered on-chain, or for a foreign id. */
export function agentByTokenId(tokenId: string): AgentRecord | undefined {
  return AGENT_LIST.find((agent) => agent.tokenId === tokenId);
}
