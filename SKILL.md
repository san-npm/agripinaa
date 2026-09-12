---
name: agripinaa-agents
description: Discover, vet and hire ERC-8004 AI agents on BNB Smart Chain using The Graph (Agent0 ERC-8004 subgraph, Messari lending subgraphs, Subgraph MCP) and the Agripinaa marketplace API. Use when asked to find an on-chain agent, check an agent's provable track record, compare Venus and Aave supply rates on BSC, or activate an Agripinaa agent.
---

# Agripinaa agents

Agripinaa (https://agripinaa.vercel.app) lists AI agents registered under
ERC-8004 on BNB Smart Chain (chain id 56) and shows, per agent, three layers
of evidence: identity from the registry, reputation from on-chain feedback,
and execution quality computed from Ophis batch-auction settlements. Nothing
is self-reported.

## Where the data lives on The Graph

| Data | Subgraph (The Graph Network) | Id |
|---|---|---|
| ERC-8004 agents, registration files, feedback on BSC | Agent0 ERC-8004, BSC mainnet | `D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K` |
| Venus supply and borrow rates on BSC | Messari standardized lending, Venus BSC | `CwswJ7sfENafqgAYU1upn3hQgoEV2CXXRZRJ7XtgJrKG` |
| Aave V3 supply and borrow rates on BSC | Messari standardized lending, Aave V3 BSC | `43jbGkvSw55sMvYyF6MZieksmJbajMu3hNGF8PN9ucuP` |

Query endpoint: `https://gateway.thegraph.com/api/subgraphs/id/<id>` with
`Authorization: Bearer <GRAPH_API_KEY>` (a Subgraph Studio key). With the
Subgraph MCP server connected, ask it to run these queries by subgraph id
instead of calling the gateway yourself.

## Find agents

Newest first, keyed on the numeric agentId (do not use `skip`, the gateway
caps it at 5000 and the BSC registry is far past that):

```graphql
query Agents($first: Int!, $before: BigInt) {
  agents(first: $first, where: { agentId_lt: $before }, orderBy: agentId, orderDirection: desc) {
    id agentId owner agentWallet createdAt totalFeedback
    registrationFile { name description x402Support mcpEndpoint a2aEndpoint webEndpoint }
  }
}
```

The Agripinaa first-party agents are agentIds 269703, 269704, 269705, 269706,
307485, 307486, 307487, 307488. Their `registrationFile.name` starts with
"Agripinaa". Search by text:

```graphql
query Search($q: String!) {
  agents(first: 50, where: { or: [
    { registrationFile_: { name_contains_nocase: $q } },
    { registrationFile_: { description_contains_nocase: $q } }
  ] }) { id agentId registrationFile { name description } }
}
```

Or use the marketplace API, which classifies agents into the four categories
(grid, yield, health-factor, rebalancing) and labels every page with the lane
that answered (`source: the-graph`):

```
GET https://agripinaa.vercel.app/api/index/agents?category=grid&limit=24
```

## Read an agent's evidence

- Feedback rows: `feedbacks(where: { agent: "56:<agentId>" }, orderBy: createdAt, orderDirection: desc)`.
- What the agent did, with transaction hashes: `GET https://agripinaa.vercel.app/api/proof`
  (events carry `agent` = agentId, `kind`, `summary`, `txHash` or `orderUid`).
- Execution quality of its wallet: `GET https://agripinaa.vercel.app/api/exec/<agentWallet>/orders`.
- One fill's receipt: `GET https://agripinaa.vercel.app/api/exec/receipt/<orderUid>`.

Report provenance with every number: the page's `source`, and `trust.source`
on each record.

## Compare lending venues the way the Harvester does

One query shape works on both Messari subgraphs. Lender-side variable rate,
percentage, for a token:

```graphql
query Supply($token: String!) {
  _meta { block { number timestamp } }
  markets(where: { inputToken: $token }, first: 10) {
    id name totalDepositBalanceUSD rates { rate side type }
  }
}
```

Use the deepest market by `totalDepositBalanceUSD`, the rate with
`side: LENDER`, and treat a `_meta.block.timestamp` older than six hours as
unavailable. USDT on BSC is `0x55d398326f99059ff775485246999027b3197955`
(lowercase, as the subgraph keys tokens). This is exactly what
`apps/agents/src/graph-rates.ts` does before a yield rotation: the chain's own
rates decide, The Graph's must agree, or the agent holds.

## Hire one

Every first-party agent serves a paid `GET <runner>/<slug>/status` over x402
(0.05 USDT on BSC, permit2-exact). The runner base is injected into each
agent's manifest at `https://agripinaa.vercel.app/manifests/<slug>.json`.
A wallet registered in World's AgentBook gets three free reads per human per
endpoint: send the signed AgentKit header the 402 asks for.

To delegate funds, open `https://agripinaa.vercel.app/agent/56/<agentId>/activate`
in a browser: a passkey smart account, one gas top-up, and a fail-closed
session scope (exact contracts and selectors, spend ceilings, expiry). Agents
cannot name a third-party recipient.
