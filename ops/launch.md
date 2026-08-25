# Running the reference agents

The agents run as ONE Node process (`apps/agents`, `pnpm --filter @agripinaa/agents start`)
plus a Cloudflare tunnel exposing the x402 status endpoints. Current hosting:
the Aleph Cloud VM (see the migration section below), as two systemd units,
`agripinaa-runner` and `agripinaa-tunnel`. The process is host-agnostic, and
the commands below still run it on a development Mac.

## Start

```bash
./ops/start-agents.sh          # starts runner + tunnel, writes ops/tunnel-url.txt
./ops/stop-agents.sh           # stops both
tail -f apps/agents/data/*.log.jsonl
```

The same tunnel also exposes the public, bounded `GET /proof` JSON feed. The web
app resolves that base URL once, in `apps/web/src/lib/runner-url.ts`, in this
order: `AGENTS_BASE_URL` (deployment override) -> KV (self-reported by the VM)
-> a committed default. The agent manifests are served from that same value, so
one URL update reaches the proof feed, the x402 endpoints, and managed
activation at once. No manifest file to edit, no redeploy.

## When the tunnel URL changes

A quick tunnel takes a new hostname on every cold start. The VM reports it:

```bash
./ops/report-runner-url.sh                # discover from the tunnel log, then post
./ops/report-runner-url.sh https://x.tld  # post a URL you already know
./ops/report-runner-url.sh --dry-run      # discover and print it, post nothing
```

`deploy-aleph.sh` installs it as `ExecStartPost` on the `agripinaa-tunnel` unit
and also runs it at the end of a deploy, so in normal operation nobody runs it
by hand. It takes the last hostname logged since the unit's most recent start
(the journal still carries the previous, dead one after a restart), waits for
the Cloudflare edge to answer `GET <url>/healthz` for it (a dead hostname no
longer resolves; a 502 means the tunnel is up and the runner is still starting,
which is reported as well), and only then posts to `POST /api/ops/runner-url`,
which checks the bearer token, requires https and a public host, resolves the
hostname and rejects anything landing on a private address, then writes the
value to KV. A candidate that never answers is refused with exit 1.

### Env vars this needs

On Vercel (project settings, Production):

| Var | Purpose |
| --- | --- |
| `OPS_TOKEN` | Shared secret for `/api/ops/runner-url`. Generate with `openssl rand -hex 32`. Until it is set the route answers 503 and accepts nothing. |
| `KV_REST_API_URL` | Upstash REST endpoint. Without it a report is accepted and then dropped, so the route answers 503 rather than reporting success. |
| `KV_REST_API_TOKEN` | Upstash REST token. |
| `AGENTS_BASE_URL` | Optional. A fixed runner base that wins over KV, for local dev, incident response, or the Tailscale route below. |
| `BSC_LOG_RPC_URLS` | Optional. The endpoints `/funds` scans the router's `Rotated` log with, replacing the free public ones compiled in. Comma separated, in the order to try them, each `url` or `url\|maxBlocksPerQuery` (default 9000). Set it to an endpoint you control: without it the page depends on someone else's public allowance, and when that throttles the panel shows its addresses and security notes with the balances marked unavailable. |

To provision the KV: Vercel dashboard -> the project -> Storage -> Create
Database -> Upstash Redis. Connecting it to the project injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically; redeploy so the
running deployment picks them up.

On the VM, create `ops/ops.env` (gitignored, and untracked files survive the
`git reset --hard` in the deploy script):

```bash
ssh <host> 'umask 077 && echo "OPS_TOKEN=<the same value as on Vercel>" > ~/agripinaa/ops/ops.env && chmod 600 ~/agripinaa/ops/ops.env'
```

The deploy script refuses to source it at any mode other than 600.

Check it end to end with `./ops/report-runner-url.sh --dry-run` on the VM (which
posts nothing), then without the flag. A 401 means the two tokens differ, a 503
means Vercel is missing `OPS_TOKEN` or the KV vars.

### Preferred: a permanent hostname instead

Rotation only exists because quick tunnels are ephemeral. Tailscale Funnel
gives the VM a stable public hostname and removes the problem entirely:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                 # authenticate the machine to your tailnet
sudo tailscale funnel 4410 on     # serves https://<host>.<tailnet>.ts.net
```

Set that URL once as `AGENTS_BASE_URL` on Vercel. It wins over KV, so the
reporting path stays in place as a fallback but never has to run. Funnel needs
HTTPS and the Funnel node attribute enabled in the tailnet policy file.

## One-time setup (already done in order)

1. `pnpm --filter @agripinaa/agents fund -- --gen` create wallets
2. `pnpm --filter @agripinaa/agents fund -- --execute` split the budget from spike-a
3. `pnpm --filter @agripinaa/agents register` mint ERC-8004 identities (mainnet)

## Aleph Cloud migration (preferred)

Order matters: agent state (grid center, LP position tokenId, breakers) is
git-tracked, so the hand-off travels through git and the Mac must stop and
commit BEFORE the VM starts (running both = double trading).

1. Create a Debian/Ubuntu instance at console.aleph.cloud (2 vCPU / 2-4 GB
   is plenty) with the deploy public key from ~/.ssh/agripinaa-aleph.pub.
   Pin its host keys before the first deploy, since that connection ships the
   wallet keys: `ssh-keyscan -p <port> <ip> >> ops/known_hosts`, review, commit.
   The deploy script checks them strictly and refuses an unknown or changed key.
2. On the Mac: `./ops/stop-agents.sh && git add apps/agents/data && git commit -m "state hand-off" && git push`
3. `./ops/deploy-aleph.sh <user@host>`   # provisions, syncs secrets, systemd
4. Nothing: the deploy reports the tunnel URL itself once `ops/ops.env` exists
   on the VM. Confirm from the line it prints, or re-run the reporter there.

Re-running deploy-aleph.sh updates code and restarts services. From then on
agent state lives on the VM; commit it back from there if migrating again.
