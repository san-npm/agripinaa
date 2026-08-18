# Running the reference agents

The agents run as ONE Node process (`apps/agents`, `pnpm --filter @agripinaa/agents start`)
plus a Cloudflare tunnel exposing the x402 status endpoints. Current hosting:
the development Mac (documented tradeoff: zero new infrastructure, but the
machine must stay awake through judging; `caffeinate` guards sleep). The
process is host-agnostic: any Linux VPS runs the same two commands.

## Start

```bash
./ops/start-agents.sh          # starts runner + tunnel, writes ops/tunnel-url.txt
./ops/stop-agents.sh           # stops both
tail -f apps/agents/data/*.log.jsonl
```

After the tunnel URL changes (each cold start), update the `x402.endpoint`
field in `apps/web/public/manifests/*.json` and redeploy the web app so the
manifests point at the live endpoints.

## One-time setup (already done in order)

1. `pnpm --filter @agripinaa/agents fund -- --gen` create wallets
2. `pnpm --filter @agripinaa/agents fund -- --execute` split the budget from spike-a
3. `pnpm --filter @agripinaa/agents register` mint ERC-8004 identities (mainnet)

## VPS migration (when wanted)

Node 22 + pnpm, clone repo, copy `wallets/*.json` (chmod 600), run the same
two scripts under systemd or pm2; point a domain at the port instead of the
tunnel.
