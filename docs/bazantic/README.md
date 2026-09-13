# Bazantic: gateways and recipes

Two gateways and two recipes, so an agent on Claude, ChatGPT or any MCP
client can discover, vet and hire an Agripinaa agent without reading our
docs. Both OpenAPI documents are served by the marketplace so Bazantic can
fetch them. Created 2026-09-13 under the Bazantic account **San Clemente**.

| Gateway | Slug | Upstream | Spec | Routes |
|---|---|---|---|---|
| Agripinaa Agent Index | `j2xpuc3sdrak5fllhacdu3mmxy` | https://agripinaa.vercel.app | [`/openapi.json`](https://agripinaa.vercel.app/openapi.json) | `GET /api/index/agents`, `GET /api/proof`, `GET /api/exec/{owner}/orders`, `GET /api/exec/receipt/{uid}` |
| Ophis Rebates (new to Bazantic) | `7frrldq67jdvzofqivwpd22byy` | https://rebates.ophis.fi | [`/openapi-ophis-rebates.json`](https://agripinaa.vercel.app/openapi-ophis-rebates.json) | `GET /stats`, `GET /rank/{wallet}`, `GET /xp/{wallet}`, `GET /leaderboard` |

Gateway base URLs: `https://<slug>.bazgateway.com`, MCP server at `/mcp`.
To use one from Claude Code:

```bash
claude mcp add --transport http ophis-rebates https://7frrldq67jdvzofqivwpd22byy.bazgateway.com/mcp
claude mcp add --transport http agripinaa-agent-index https://j2xpuc3sdrak5fllhacdu3mmxy.bazgateway.com/mcp
```
Every route costs 1000 millicents (one cent) in USDC; the upstreams are free,
the gateway sets the price. A correct path answers 402 with the exact price
(x402 on Base USDC, or MPP); a wrong path answers 404.

| Recipe | Handle | Tools |
|---|---|---|
| [Hire an ERC-8004 agent on BSC by provable execution](recipe-hire-an-agent.json) | `hire-an-erc-8004-agent-on-bsc-by-provable-execut` | listAgents, getExecutionSummary, getProofFeed, getReceipt |
| [Vet a wallet: Ophis rebate tier plus Agripinaa execution quality](recipe-vet-a-trader.json) | `vet-a-wallet-ophis-rebate-tier-plus-agripinaa-ex` | getWalletRank (Ophis), getExecutionSummary (Agripinaa) |

The runner's paid `GET /:agent/status` is not wrapped: it is already x402 and
its tunnel hostname rotates, so a gateway pointed at it would break on the
next cold start. The index, proof feed and receipts on Vercel are stable.

## How they were created

```bash
npm i -g @bazantic/cli
baz login                      # browser approval; the device gets gateway + recipe scopes, no spending

baz gateway add \
  --spec-url https://agripinaa.vercel.app/openapi.json \
  --endpoint https://agripinaa.vercel.app \
  --name "Agripinaa Agent Index" --status active --json

baz gateway add \
  --spec-url https://agripinaa.vercel.app/openapi-ophis-rebates.json \
  --endpoint https://rebates.ophis.fi \
  --name "Ophis Rebates" --status active --json

baz recipe create docs/bazantic/recipe-hire-an-agent.json --json
baz recipe create docs/bazantic/recipe-vet-a-trader.json --json
baz recipe publish hire-an-erc-8004-agent-on-bsc-by-provable-execut --json
baz recipe publish vet-a-wallet-ophis-rebate-tier-plus-agripinaa-ex --json
```

Three things the docs did not say and the CLI told us: `model` must be one
of the CLI's listed ids (`anthropic/claude-sonnet-4.6` here); the gateway's
MCP server answers 404 to a bare `tools/list` sent before the MCP
`initialize` handshake, so probe it with an MCP client rather than curl; and
`recipe publish` can fail once with "Control MCP request failed" and succeed
unchanged on the retry.

## Using them from an agent

```bash
baz recipe install --client claude-code   # registers the Recipe MCP adapter
baz grant create --name agent-1 --cap 5   # a capped, revocable payer for it
```

Then ask for "the best grid agent on BSC with proof of its latest fill", or
"vet wallet 0x…", and the recipe drives the paid calls.

## The before/after comparison (prize 1)

Same task, same model, same settings, twice: once with the raw API, once with
the recipe as the only difference.

Task prompt (both runs):

> Find the grid-trading agent on BNB Smart Chain with the best provable
> execution quality, and give me the settlement transaction of its most
> recent fill.

- **Raw API run:** give the model `https://agripinaa.vercel.app/openapi.json`
  and nothing else. Record the tool calls it makes and whether it reaches a
  transaction hash.
- **Recipe run:** install the recipe MCP as above and give the model the same
  prompt. Record the same.

What the recipe adds that the spec cannot: the order of operations (list by
category, rank candidates by measured surplus through the execution summary,
then read the proof feed for the winner, then fetch the receipt for its newest
`orderUid`), which field is the join key (`agent` in a proof event is the
ERC-8004 token id from `tokenId` in the listing; `agentWallet` in the listing
is the key for the execution summary), and the fact that `trust.source` says
which lane answered so the model reports provenance instead of averaging.

Record both runs on screen; the submission wants the inputs and results side
by side plus the recording, and the Bazantic username (San Clemente).
