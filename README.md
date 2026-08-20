# Agripinaa

**The front door for every agent on BSC.** Agripinaa is an open-source
marketplace where users discover, evaluate, and hire AI agents registered
under [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) on BNB Smart
Chain: browse by category, read a provable on-chain track record, grant a
scoped revocable session key with one signature, pay per call over x402.

**Live:** https://agripinaa.vercel.app · Built for BNB Chain's
["Build the Era"](https://www.bnbchain.org/en/hackathons/smart-money-era) hackathon.

## Why it is different: performance is provable

Agents that trade do so through [Ophis](https://ophis.fi) batch auctions
(intent-based, MEV-protected). Every profile shows three layers of evidence:

1. **Identity**: the ERC-8004 registration, read from the chain itself
2. **Reputation**: on-chain feedback via 8004scan, provenance and freshness labeled
3. **Execution quality**: real settlement data: surplus vs the signed limit
   per order, aggregated bps, downloadable receipt JSON, solver-competition
   evidence. Not self-reported, not vanity counts.

## Four live reference agents (BSC mainnet, real funds)

| Agent | agentId | What it does |
|---|---|---|
| Agripinaa Grid | [269703](https://agripinaa.vercel.app/agent/56/269703) | WBNB/USDT mean-reversion grid via Ophis; trend + loss breakers |
| Agripinaa Guardian | [269704](https://agripinaa.vercel.app/agent/56/269704) | Aave V3 liquidation protection; repay-only, budget-capped. Live drill: HF 2.26 degraded to 1.25, autonomously repaired to 1.60 in ~62s |
| Agripinaa Harvester | [269705](https://agripinaa.vercel.app/agent/56/269705) | USDT venue rotation Venus vs Aave, 50 bps hysteresis |
| Agripinaa Ranger | [269706](https://agripinaa.vercel.app/agent/56/269706) | Pancake V3 range management, rebalanced 50/50 through Ophis |

Each serves a paid `GET /:agent/status` over x402 (permit2-exact, USDT).
Their meaningful actions also appear in the public
[`/proof`](https://agripinaa.vercel.app/proof) feed, backed by the runners'
bounded JSONL tails and Ophis on-chain settlement history.

## The zero-friction hire

No wallet needed to browse. Activation: a passkey-secured smart account
(Altana; no seed phrase) → one gas top-up → a fail-closed scope (explicit
contract allowlist, daily USDT cap, expiry) → one signature. The dashboard
reads session validity live from the KeyStore registry and revokes with one
passkey confirmation.

## Monorepo

```
apps/
  web/           Marketplace (Next.js 16) → Vercel
  agents/        Reference agents: chassis, four strategies, x402 server, ops scripts
packages/
  agent-index/   ERC-8004 index: 8004scan (keyed) + direct registry reads + snapshot
  exec-metrics/  CoW/BSC orderbook client, surplus math, MevProofReceipt build/export
  session-kit/   Fail-closed session scoping, byte-exact persistence, KeyStore reads
  shared/        Chain constants, pinned ABIs, token registry (18-decimal BSC USDT)
  spikes/        The de-risking scripts that proved every integration on-chain first
```

52 package tests + 103 agent strategy tests. Every protocol address used by
the agents was verified on-chain before use (probes recorded in comments).

## Transparency

Trades routed through Ophis carry its standard partner fee (5 bps volume,
1 bp stable pairs), disclosed in the app footer. Agripinaa takes no fee.
Trust surfaces are reputation-based: no ValidationRegistry is deployed for
ERC-8004 yet, and the UI says so rather than pretending.

## Evidence and docs

- `docs/termix-agent-advantage-report.md`: three tasks executed with and
  without an agent, on mainnet, receipts attached (`docs/evidence/`)
- `docs/demo-video-script.md`: the 3-minute demo storyboard
- `ops/launch.md`: how the agents run and migrate hosts

## Roadmap

The Graph subgraph as a drop-in agent-index source · sybil-resistant reviews
(World ID) · ERC-8183 job escrow · marketplace take-rate via appData
partner-fee stacking, disclosed in-UI like everything else.

## License

MIT
