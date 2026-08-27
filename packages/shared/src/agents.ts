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
 * 1. A REGISTERED agent's `manifest` is byte-sensitive. It is served at
 *    /manifests/<slug>.json, which is the tokenURI of an already-minted,
 *    immutable ERC-8004 identity. Those bytes must not change: not a value,
 *    not a key, not the ORDER of the keys, since the body is JSON.stringify'd
 *    in declaration order. tests/agents.test.ts pins each registered agent's
 *    exact bytes.
 * 2. `wallet` is the agent's PUBLIC address. Signer secrets live only in
 *    wallets/*.json and are never read here.
 *
 * `tokenId` and `wallet` are both nullable, so an agent can exist in config and
 * be unit-tested before its key is generated and its identity minted. Such a
 * record is inert everywhere it matters: no verified badge, no proof-feed
 * identity, and the runner skips it rather than failing to boot.
 */

import type { ManagedToken } from './contracts';

export type AgentSlug =
  | 'grid'
  | 'grid-b'
  | 'health-factor'
  | 'venus-guardian'
  | 'yield'
  | 'yield-b'
  | 'lp-range'
  | 'weight-rebalancer';

/** Marketplace category. Matches @agripinaa/agent-index's `Category`. */
export type AgentCategory = 'grid' | 'health-factor' | 'yield' | 'rebalancing';

/**
 * `safety` mixes numeric limits with allowlists (health-factor's `actions`) and
 * short policy statements, for the caps a number cannot express: what happens
 * when a limit is breached, and what the limit is measured against. Those
 * belong in the published manifest rather than only in the code, because the
 * manifest is what a hirer reads before trusting the agent with capital.
 */
export type SafetyValue = number | string | string[];

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

/**
 * One-time funding transfer sizes, in whole units. Every optional leg here must
 * also appear in the transfer loop of apps/agents/src/fund.ts, or the budget is
 * planned and silently never sent; tests/agent-config.test.ts pins the plan
 * field by field for exactly that reason.
 */
export interface AgentFunding {
  bnb: string;
  usdt?: string;
  usdc?: string;
  wbnb?: string;
  /** Bitcoin BEP20, the sell-side leg of a grid quoting BTCB. */
  btcb?: string;
}

export interface AgentRecord {
  slug: AgentSlug;
  /** ERC-8004 token id on BSC mainnet, or null before registration. */
  tokenId: string | null;
  name: string;
  category: AgentCategory;
  /**
   * The agent's public wallet: what it trades from, never a signer secret.
   * Null until `fund --gen` creates the key, since the address is not knowable
   * before then. A record with a null wallet is configuration only: nothing
   * funds it, nothing attributes proofs to it, and the runner skips it.
   */
  wallet: `0x${string}` | null;
  /** File under wallets/ holding this agent's own-capital key. */
  walletFile: string;
  /** Can manage user funds through a scoped session key on a router. */
  managed: boolean;
  /**
   * The PUBLIC address of the manager key each managed token's sessions are
   * granted to, captured from the live runner's GET /<slug>/manager-key. The
   * browser refuses a reported key that does not match this before it becomes
   * a session grantee, which is what makes a hijacked runner base fail closed.
   * Only a managed agent carries one; absent until the key is generated, and
   * the browser logs and accepts a report it has no pin for. Never a secret:
   * the private half lives only in wallets/agent-<slug>-session.json.
   */
  managerKeys?: Partial<Record<ManagedToken, `0x${string}`>>;
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
  /* Wallet funded and identity registered; attestation and proof remain pending. */
  'grid-b': {
    slug: 'grid-b',
    tokenId: '307485',
    name: 'Agripinaa BTC Grid',
    category: 'grid',
    wallet: '0x4A66d9f68CA6be7A44fDb891C0346c2381BF0D6d',
    walletFile: 'agent-grid-b.json',
    managed: false,
    backfillOphisTrades: true,
    manifest: {
      name: 'Agripinaa BTC Grid',
      description:
        'Mean-reversion grid trader on the BTCB/USDT pair, running a wider and slower ladder than Agripinaa Grid: five levels each side at 2.5 percent spacing, $1.50 clips, 8 trades a day at most, and 45 minutes between fills. Every swap executes through Ophis batch auctions (MEV-protected, a receipt for every fill). Halts itself on a trend breakout and on an inventory drawdown.',
      category: 'grid',
      image: 'https://agripinaa.vercel.app/agent-icon.png',
      capabilities: ['trading', 'x402-status'],
      execution: { venue: 'ophis', pair: 'BTCB/USDT', chainId: 56 },
      /*
       * These are the numbers the tick enforces, not a summary of them:
       * tests/grid-b.test.ts pins each field to GRID_B_PARAMS, so a parameter
       * change that did not reach the manifest fails the build.
       */
      safety: {
        maxTradesPerDay: 8,
        perTradeClipUsd: 1.5,
        minTradeClipUsd: 1,
        gridSpacingPct: 2.5,
        levelsPerSide: 5,
        cooldownMinutes: 45,
        trendHaltBandPct: 6,
        lossHaltPct: 5,
        maxRecentersPerDay: 3,
        lossHaltBaseline:
          'inventory value at the first tick, never re-baselined, so the 5 percent floor is cumulative over the agent lifetime rather than daily',
        onHalt:
          'trading stops and stays stopped until an operator clears the agent state file; there is no automatic resume',
      },
      x402: { priceUsdt: '0.05', note: 'pending registration' },
    },
    /*
     * One leg per side of the pair, since a grid spends both: the buy side
     * sells USDT and the sell side sells BTCB, so a leg funded in any other
     * token would leave that whole direction blocked on an empty balance while
     * the money sat somewhere the agent never reaches. WBNB is gone from this
     * budget because it is no longer on the pair.
     *
     * 0.000025 BTCB was about $1.97 at the price the fee-500 pool reported on
     * 2026-08-25 (78,851 USDT per BTCB), so it funds one full $1.50 clip, which
     * is the same shape the USDC/WBNB budget had. NOTE FOR THE OPERATOR: the
     * spike-a wallet this transfers from holds no BTCB today, so this leg has to
     * be acquired before `fund --execute` reaches it.
     */
    funding: { bnb: '0.0015', usdt: '2', btcb: '0.000025' },
    registrationTx: '0xbb75b0bb6620b85ae53d38235b410a85c507b161ea0ad673167fc0a7d40d85eb',
    attestation: null,
    proofs: [],
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
  /* Fully registered and execution-attested from its first live Venus repair. */
  'venus-guardian': {
    slug: 'venus-guardian',
    tokenId: '307486',
    name: 'Agripinaa Venus Guardian',
    category: 'health-factor',
    wallet: '0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173',
    walletFile: 'agent-venus-guardian.json',
    managed: false,
    backfillOphisTrades: false,
    manifest: {
      name: 'Agripinaa Venus Guardian',
      description:
        'Liquidation protection for Venus borrow positions on BSC. Reads collateral, debt, and the live market collateral factor every minute, derives the health factor Venus does not publish, and repays USDT from its own budget to lift the position back to 1.6 before liquidation can trigger. Repay only: it never borrows, never withdraws collateral, and never exits a market.',
      category: 'health-factor',
      image: 'https://agripinaa.vercel.app/agent-icon.png',
      capabilities: ['monitoring', 'x402-status'],
      execution: { protocol: 'venus', chainId: 56 },
      /*
       * The numbers the tick enforces, pinned to the module's constants by
       * tests/venus-guardian.test.ts. The two prose entries carry what a number
       * cannot: where the health factor comes from (Venus publishes a shortfall,
       * not a ratio) and what happens when the repay budget runs out.
       */
      safety: {
        actions: ['repay'],
        warnHF: 1.5,
        actHF: 1.3,
        targetHF: 1.6,
        maxRepaysPerDay: 6,
        tickSeconds: 60,
        healthFactorSource:
          'derived from collateral value, borrow value and the collateral factor read live from Comptroller.markets on every tick, because Venus reports liquidity and shortfall rather than a ratio; the derivation is cross-checked against that shortfall each tick',
        onBudgetExhausted:
          'the agent keeps monitoring and keeps reporting; it never sells or withdraws collateral to fund a repay',
      },
      x402: { priceUsdt: '0.05', note: 'pending registration' },
    },
    funding: { bnb: '0.0015', usdt: '2', wbnb: '0.005' },
    registrationTx: '0xf0c59a0aae6a8f94e7aa899488de869515ec93743c0c850df5d425cdd21e40a0',
    attestation: {
      txHash: '0xdd938692c2c3f6eb1f6813171e177e1d9af20882ad0324871ba3d1cc954eb450',
      verifier: VERIFIER,
      tag: 'agripinaa-verified · health-factor',
      feedbackHash: '0x244903446100c31d00763a40478eb52ec4407b346b46f2183bee7718117197f8',
    },
    proofs: [
      {
        label: 'repair-done',
        ref: '0xd9817ea31984019038303cbcb1aeea46bc44ae98bd6fe0ef0bdc83a1a80f5808',
        kind: 'tx',
        note: 'Repaid 0.442891721262516486 USDT on Venus, restoring HF from 1.27 to 1.60',
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
    // Rotated 2026-08-26 after the file-permission audit: USDT is the master
    // key, USDC the key derived from it (apps/agents/src/manager-key.ts).
    managerKeys: {
      USDT: '0x085f9F61ff6d65a3632Fe0a4443a33d1E10341a2',
      USDC: '0x1A06C18C97B891E4d9F89829E74b08A3e0891646',
    },
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
  /* Fully registered and execution-attested from its first live Venus supply. */
  'yield-b': {
    slug: 'yield-b',
    tokenId: '307487',
    name: 'Agripinaa Steward',
    category: 'yield',
    wallet: '0x454aC9bae8cC6eA1067F7422992A9Ab2e8DCEdF3',
    walletFile: 'agent-yield-b.json',
    managed: true,
    managerKeys: {
      USDT: '0xB11A2D73C6c52dd0d375785Bfb32B9f1c3E70D01',
      USDC: '0x66641f1c347bc9D4310166890636531CCbFcEF70',
    },
    backfillOphisTrades: false,
    manifest: {
      name: 'Agripinaa Steward',
      description:
        'Stablecoin yield rotation across BSC lending venues, run patiently. Compares live Venus and Aave supply rates every twelve hours and moves a deposit only when the other venue leads by 120 bps on three consecutive checks, and never more than once every two days. The same policy applies to its own capital and to every account it manages, and funds move through a router that can only ever pay them back to their owner.',
      category: 'yield',
      image: 'https://agripinaa.vercel.app/agent-icon.png',
      capabilities: ['session-keys', 'x402-status'],
      execution: { asset: 'USDT', chainId: 56 },
      /*
       * The numbers the tick enforces, pinned to YIELD_B_PARAMS by
       * tests/yield-b.test.ts. Same key names as the Harvester's where they
       * mean the same thing, so the two are comparable side by side.
       */
      safety: {
        maxMovesPerDay: 1,
        hysteresisBps: 120,
        thresholdComparator: 'inclusive',
        confirmations: 3,
        minHoursBetweenMoves: 48,
        checkEveryHours: 12,
        venues: ['venus', 'aave'],
        custody:
          'funds stay in the depositor account throughout; the agent holds a session key scoped to one router whose every recipient is hardcoded to that same account, so it can never send funds anywhere else and never withdraws to itself',
        onRevoke:
          'revoking the session stops all further moves; the position stays where it is and the depositor withdraws it themselves',
      },
      recommendedScope: { spendCapUsdtPerDay: '250', expiresHours: 720 },
      x402: { priceUsdt: '0.05', note: 'pending registration' },
    },
    funding: { bnb: '0.0015', usdt: '1' },
    registrationTx: '0x4d3d55f3c17290a7e3dc04349f6e2ad5422b1cfb3aea46a3110500c07dc5a85e',
    attestation: {
      txHash: '0xec7cf7f7b13bdd4607d0cef66e0a6bc2ce70d78e0851bbd40b1f615ce09f95f3',
      verifier: VERIFIER,
      tag: 'agripinaa-verified · yield',
      feedbackHash: '0xebf6999d9f572a91a835f849ae304cfa41f007a68a21c5b0b50e9bd5f129ba28',
    },
    proofs: [
      {
        label: 'supply',
        ref: '0xbf543e86567cbfd26e2d9cfbbc9136076d71070a7814dbdffa23655da028d40b',
        kind: 'tx',
        note: 'Supplied 0.9 USDT to Venus on the first live Steward tick',
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
  /* Wallet funded and identity registered; attestation and proof remain pending. */
  'weight-rebalancer': {
    slug: 'weight-rebalancer',
    tokenId: '307488',
    name: 'Agripinaa Rebalancer',
    category: 'rebalancing',
    wallet: '0x2516deB9E76995fd7eb0911AacEA441c12ccc98C',
    walletFile: 'agent-weight-rebalancer.json',
    managed: false,
    backfillOphisTrades: true,
    manifest: {
      name: 'Agripinaa Rebalancer',
      description:
        'Portfolio-weight rebalancer holding WBNB and USDT at a 50/50 split by value. Checks the split every 10 minutes and, when drift leaves a 5 percent band, restores the target with a single Ophis batch-auction swap (MEV-protected, a receipt for every rebalance). Sized to the distance from target and no further, so it can neither overdraw a leg nor overshoot into the opposite drift.',
      category: 'rebalancing',
      image: 'https://agripinaa.vercel.app/agent-icon.png',
      capabilities: ['trading', 'x402-status'],
      execution: { venue: 'ophis', pair: 'WBNB/USDT', chainId: 56 },
      /*
       * The numbers the tick enforces, pinned to the module's exported
       * constants by tests/weight-rebalancer.test.ts.
       */
      safety: {
        targetWeightPct: 50,
        driftBandPct: 5,
        maxRebalancesPerDay: 4,
        minTradeUsd: 1,
        cooldownMinutes: 35,
        tickMinutes: 10,
        maxTradeSize:
          'the distance from the target weight, which is at most half the overweight side, never the whole balance',
        onHalt:
          'no automatic halt: the agent takes no directional view, so the daily cap, the cooldown and the minimum notional are the limits',
      },
      x402: { priceUsdt: '0.05', note: 'pending registration' },
    },
    funding: { bnb: '0.0015', usdt: '2.5', wbnb: '0.004' },
    registrationTx: '0xcf6a2d2c86cc72e8c4c02e772ada6be228abaae2136d7f4d5b5a0e69ffbbc77c',
    attestation: null,
    proofs: [],
  },
};

export const AGENT_LIST: AgentRecord[] = Object.values(AGENTS);

/**
 * Undefined for any slug that is not a first-party agent.
 *
 * Own keys only. Callers gate on this with a slug taken off a URL or a form
 * field, and a plain object answers `constructor`, `__proto__` and the rest of
 * Object.prototype with something truthy, which every such gate would read as
 * "this agent exists" and let through to a KV read and an upstream fetch.
 */
export function agentBySlug(slug: string): AgentRecord | undefined {
  if (!Object.hasOwn(AGENTS, slug)) return undefined;
  return (AGENTS as Record<string, AgentRecord | undefined>)[slug];
}

/** Undefined before an agent is registered on-chain, or for a foreign id. */
export function agentByTokenId(tokenId: string): AgentRecord | undefined {
  return AGENT_LIST.find((agent) => agent.tokenId === tokenId);
}

/**
 * The manager-key address pinned for one agent and managed token, or undefined
 * when nothing is pinned (an unknown agent, an unmanaged one, or a managed one
 * whose key has not been generated and captured yet).
 */
export function pinnedManagerKeyAddress(agent: string, token: string): `0x${string}` | undefined {
  return agentBySlug(agent)?.managerKeys?.[token as ManagedToken];
}
