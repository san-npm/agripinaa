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

## Aleph Cloud migration (preferred)

1. Create a Debian/Ubuntu instance at console.aleph.cloud (2 vCPU / 2-4 GB
   is plenty) with the deploy public key from ~/.ssh/agripinaa-aleph.pub.
2. ./ops/deploy-aleph.sh <user@host>   # provisions, syncs secrets, systemd
3. ./ops/set-x402-endpoint.sh <tunnel-url-it-prints>
4. ./ops/stop-agents.sh on the Mac (never run both: double trading).

Re-running deploy-aleph.sh updates code and restarts services. Agent state
lives on the VM under ~/agripinaa/apps/agents/data/ from then on.
