# Bazantic: gateways and recipes

Two gateways and two recipes, so an agent on Claude, ChatGPT or any MCP
client can discover, vet and hire an Agripinaa agent without reading our
docs. Both OpenAPI documents are served by the marketplace so Bazantic can
fetch them:

- `https://agripinaa.vercel.app/openapi.json`: the Agripinaa Agent Index
  (`apps/web/public/openapi.json`). Free upstream; the gateway sets the price.
- `https://agripinaa.vercel.app/openapi-ophis-rebates.json`: the Ophis Rebates
  API (`apps/web/public/openapi-ophis-rebates.json`), an API that was not on
  Bazantic or any sponsor at event start. Upstream `https://rebates.ophis.fi`.

The runner's paid `GET /:agent/status` is not wrapped: it is already x402 and
its tunnel hostname rotates, so a gateway pointed at it would break on the
next cold start. The index, proof feed and receipts on Vercel are stable.

## Operator steps (one time, needs a browser login)

```bash
npm i -g @bazantic/cli
baz login

baz gateway add \
  --spec-url https://agripinaa.vercel.app/openapi.json \
  --endpoint https://agripinaa.vercel.app \
  --name "Agripinaa Agent Index" --status active --json
# note the slug it prints, e.g. agripinaa-agent-index

baz gateway add \
  --spec-url https://agripinaa.vercel.app/openapi-ophis-rebates.json \
  --endpoint https://rebates.ophis.fi \
  --name "Ophis Rebates" --status active --json
# note the slug, e.g. ophis-rebates

# Put the two slugs into the recipes' tool_bindings, then:
baz recipe create docs/bazantic/recipe-hire-an-agent.json --json
baz recipe create docs/bazantic/recipe-vet-a-trader.json --json
baz recipe publish <handle-of-each> --json
```

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
- **Recipe run:** install the recipe MCP (`baz recipe install --client
  claude-code`) and give the model the same prompt. Record the same.

What the recipe adds that the spec cannot: the order of operations (list by
category, then read the proof feed for those token ids, then fetch the
receipt for the newest `orderUid`), which field is the join key (`agent` in a
proof event is the ERC-8004 token id from `tokenId` in the listing), and the
fact that `trust.source` says which lane answered so the model reports
provenance instead of averaging.

Record both runs on screen; the submission wants the inputs and results side
by side plus the recording.
