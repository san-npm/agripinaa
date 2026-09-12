# ETHOnline 2026: track selection

Deadline: Sunday 2026-09-13, 12:00 EDT (18:00 CEST). Agripinaa enters as a
Continuity project (existing open-source repo). Only work committed during the
event is judged; pre-existing work must be documented. Every track below wants a
public repo, a 2-4 minute video, and a real commit history (no single squash).

Total pool $75k across 11 sponsors. Ranked by fit x prize / effort under the
one-day window.

## Tier 1: build these

| Sponsor | Track | Prize | What we ship on Agripinaa | Effort |
|---|---|---|---|---|
| The Graph | 3 AI use case (Continuity) | $2.5k/1.5k/1k | Agent0 ERC-8004 BSC subgraph (`D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K`) as a new `AgentIndexSource` in `MergedSource` (roadmap item). Harvester/Steward read Venus and Aave supply rates from Messari standardized lending subgraphs (Venus BSC `CwswJ7sfENafqgAYU1upn3hQgoEV2CXXRZRJ7XtgJrKG`) and rotate on that: live Graph data driving an autonomous decision. SKILL.md so an LLM can find and hire Agripinaa agents through Subgraph MCP. | 5-8h |
| The Graph | 1 Composable / standardized (open to all) | $2.5k/1.5k/1k | Same work qualifies: two Graph products composed (Agent0 subgraph + Messari standardized schema), one lending query spanning Venus and Aave. | included |
| World | AgentKit Continuity | $1,166 x3 | Register the 8 agents in AgentBook (World Chain 480). Marketplace shows a human-backed badge resolved live from AgentBook. x402 status endpoint grants a free-trial to human-backed callers via `createAgentBookVerifier` (our server is raw `node:http`, not Hono). Feedback doc required. | 3-4h |
| Bazantic | 1 Help an agent use your project (Continuity) | $500 x2 | Publish an OpenAPI spec for the runner's `/:slug/status` and `/proof`, `baz gateway add`, one recipe, before/after comparison video. | 2h |
| Bazantic | 3 Agentify a new API | $500/300/200 | Add the Ophis quote API as a new gateway, recipe chains Ophis quote + Agripinaa status. | 1h on top |
| Uniswap Foundation | Continuity | $1k x2 | Ranger (`lp-range`) gains Uniswap v3 on BSC as a second venue: same NonfungiblePositionManager ABI as Pancake V3, different pinned addresses, probed on-chain like the rest. FEEDBACK.md + Developer Feedback Form. | 3-4h |

## Tier 2: stretch

| Sponsor | Track | Prize | Plan | Blocker |
|---|---|---|---|---|
| Ledger | Continuity | $1k/$500 | Runner wallet files and `ops/ops.env` encrypted under `wallet-cli ring`, decrypted at unit start with `WALLET_PASS` from secret-tool. | Needs a physical Ledger once for `ring init`. |
| ENS | 1 Best use of ENSv2 (open to all) | $1.5k/1.5k/1k/500 | Each agent a subname under an ENSv2 Sepolia name; permissioned resolver records carry ERC-8004 id, x402 endpoint, manager key; runner-url resolution reads ENS instead of KV. | Sepolia only; 4-6h. |

## Skip

- Arc / Circle ($3k + $2k mainnet bonus): needs the agents on Arc testnet with
  Circle Agent Wallets and there are no venues on Arc for the strategies. Too
  large for the window.
- Chainlink: Confidential Workflows is private beta (account-team enrollment),
  which kills tracks 1 and 3. Track 2 ($500) needs a new contract deploy.
- Hedera: whole-chain port for $1k continuity.
- Privy, 1inch: replace the Altana + Ophis core the project is built on.

## Submission checklist

- Register as Continuity on the ETHGlobal dashboard.
- README section separating pre-existing work from ETHOnline work.
- 2-4 minute demo video.
- Per-sponsor extras: World feedback doc, Uniswap FEEDBACK.md + form, Bazantic
  username and comparison recording.
