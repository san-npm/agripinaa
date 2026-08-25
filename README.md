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
3. **Execution quality**: settlement data, surplus against the limit each order
   was signed at, aggregated bps, and a downloadable receipt JSON carrying the
   settlement transaction and block. Not self-reported, not vanity counts.

## Four reference agents on BSC mainnet, running on their own capital

| Agent | agentId | What it does |
|---|---|---|
| Agripinaa Grid | [269703](https://agripinaa.vercel.app/agent/56/269703) | WBNB/USDT mean-reversion grid via Ophis; trend + loss breakers |
| Agripinaa Guardian | [269704](https://agripinaa.vercel.app/agent/56/269704) | Aave V3 liquidation protection; repay-only, budget-capped. Live drill: HF 2.26 degraded to 1.25, autonomously repaired to 1.60 in ~62s |
| Agripinaa Harvester | [269705](https://agripinaa.vercel.app/agent/56/269705) | USDT venue rotation Venus vs Aave, 50 bps hysteresis |
| Agripinaa Ranger | [269706](https://agripinaa.vercel.app/agent/56/269706) | Pancake V3 range management, rebalanced 50/50 through Ophis |

Each serves a paid `GET /:agent/status` over x402 (permit2-exact, USDT, 0.05
USDT a call). Their meaningful actions also appear in the public
[`/proof`](https://agripinaa.vercel.app/proof) feed, backed by the runners'
bounded JSONL tails and Ophis on-chain settlement history.

Four more agents (a second grid, a Venus-side guardian, a conservative rotator,
a weight rebalancer) are built and unit-tested under `apps/agents/src/agents/`
and declared in `packages/shared/src/agents.ts`. They wait on the owner's
sign-off on their display names before they are registered on-chain.

## What a judge is scoring, and where to look

| Criterion | Where it is answered |
|---|---|
| **Functionality**: land, browse, understand, activate, no dead ends | `/` to `/agents` to `/c/<category>` to a profile to activation to `/dashboard`. Endpoint liveness is probed rather than assumed, and an agent whose endpoint does not answer offers inspection instead of an activate button that goes nowhere. |
| **Data quality**: live data beyond counts | One score per agent with per-field provenance and a freshness stamp; execution quality computed from Ophis settlement; [`/leaderboard`](https://agripinaa.vercel.app/leaderboard) ranked on settlement-derived surplus with a squared sample-depth discount; [`/funds`](https://agripinaa.vercel.app/funds) with live router balances and every rotation on record; a proof feed that is populated at first paint. |
| **Agent diversity**: the four mandated categories | Grid, health-factor, yield and rebalancing hubs, each with a first-party agent live on mainnet, plus the indexed BSC population sorted into the same taxonomy by the shared classifier. |
| **Agent advantage**: the TermiX rubric | [`docs/termix-agent-advantage-report.md`](docs/termix-agent-advantage-report.md): eight settlements, a live liquidation drill, a managed rotation, receipts and transactions attached, dispersion and downtime reported alongside the wins. |

## The zero-friction hire

No wallet needed to browse. Activation: a passkey-secured smart account
(Altana; no seed phrase) → one gas top-up → a fail-closed scope (explicit
contract allowlist, daily USDT cap, expiry) → one signature. The dashboard
reads session validity live from the KeyStore registry and revokes with one
passkey confirmation.

For managed yield, the session key is scoped to one contract whose entrypoints
take no arguments at all: `AgripinaaYieldRouter`. Every recipient inside it is
hardcoded to the calling account, so a stolen key can move the user's funds
between the user's own positions or back to the user, and cannot name a third
party. One open Medium qualifies that: unwinding can strip a receipt token that
secures live venue debt for an account that also borrowed in the same venue,
and no managed account carries venue debt today. The threat model, the audit
finding the router already fixed, the two fuzz invariants, and that Medium in
full are in [`docs/security-router.md`](docs/security-router.md).

## Quickstart

Node 22+, pnpm 10.

```bash
pnpm install
pnpm dev          # the marketplace on http://localhost:3000
pnpm test         # every workspace
pnpm typecheck
```

The marketplace runs with no environment variables at all: the indexer falls
back to a committed BSC snapshot, and the agent endpoint falls back to a
committed default. Optional keys (`SCAN8004_API_KEY` for the keyed indexer
lane, Upstash KV, `OPS_TOKEN`, `AGENTS_BASE_URL`, `BSC_LOG_RPC_URLS`) are
documented in [`ops/launch.md`](ops/launch.md). Never commit an `.env` file.

The agents need funded wallets (`wallets/`, gitignored) and are started with
`./ops/start-agents.sh`; `ops/launch.md` covers the VM deploy. The router
contracts live in `contracts/` and run with `forge test --fork-url bsc` (10 fork
tests) plus the Echidna and Medusa harness described in the security doc.

## Monorepo

```
apps/
  web/           Marketplace (Next.js 16) → Vercel
  agents/        Reference agents: chassis, strategies, x402 server, ops CLIs
packages/
  agent-index/   ERC-8004 index: 8004scan (keyed) + direct registry reads + snapshot
  exec-metrics/  Ophis/BSC orderbook client, surplus math, MevProofReceipt build/export
  session-kit/   Fail-closed session scoping, byte-exact persistence, KeyStore reads
  shared/        Chains, pinned ABIs, tokens, routers, the agent registry, the SSRF guard
  spikes/        The de-risking scripts that proved every integration on-chain first
contracts/       AgripinaaYieldRouter, its BSC fork tests, the fuzz harness
ops/             Start, stop, deploy, and runner-URL reporting for the agent VM
docs/            Architecture, router security, the TermiX report and its evidence
```

Over 400 tests across the six workspaces (`pnpm test` at the root). Every protocol
address the agents use was probed on-chain before use, with the probe recorded
in a comment next to it. [`docs/architecture.md`](docs/architecture.md) has the
diagram and what runs where.

## Fee and trust disclosure

Agripinaa takes no fee. Trades routed through Ophis carry the Ophis fee, taken
inside the settlement rather than billed separately; since 2026-08-11 its
schedule is a 1 bp base plus a share of price improvement. Each fill's
downloadable receipt carries the partner-fee entries that order's appData
declared (`partnerFee`), and the agents' live orders still carry the appData the
pinned `@ophis/sdk` 0.3.0 emits, which
[`docs/termix-agent-advantage-report.md`](docs/termix-agent-advantage-report.md)
records per fill alongside the fee each settlement took.

Trust surfaces are reputation-based: no ValidationRegistry is deployed for
ERC-8004 yet, and the UI says so rather than pretending.

## Evidence and docs

- [`docs/architecture.md`](docs/architecture.md): the diagram, and what runs where
- [`docs/security-router.md`](docs/security-router.md): the router threat model,
  cited test by test
- [`docs/termix-agent-advantage-report.md`](docs/termix-agent-advantage-report.md):
  three tasks executed with and without an agent, on mainnet, receipts attached
  (`docs/evidence/`)
- [`docs/demo-video-script.md`](docs/demo-video-script.md): the 3-minute demo storyboard
- [`ops/launch.md`](ops/launch.md): how the agents run, deploy, and migrate hosts

## Roadmap

The Graph subgraph as a drop-in agent-index source · sybil-resistant reviews
(World ID) · ERC-8183 job escrow · marketplace take-rate via appData
partner-fee stacking, disclosed in-UI like everything else.

## License

MIT
