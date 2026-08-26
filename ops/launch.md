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
| `AGENTS_BASE_URL` | Optional. A fixed runner base that wins over KV, for local dev or incident response. |
| `BSC_LOG_RPC_URLS` | Optional. The endpoints `/funds` scans the router's `Rotated` log with, replacing the free public ones compiled in. Comma separated, in the order to try them, each `url` or `url\|maxBlocksPerQuery` (default 9000). Set it to an endpoint you control: without it the page depends on someone else's public allowance, and when that throttles the panel shows its addresses and security notes with the balances marked unavailable. |

To provision the KV: Vercel dashboard -> the project -> Storage -> Create
Database -> Upstash Redis. Connecting it to the project injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically; redeploy so the
running deployment picks them up.

On the VM, create `ops/ops.env` (gitignored; the deploy checks out code without
deleting untracked operator files):

```bash
ssh <host> 'umask 077 && echo "OPS_TOKEN=<the same value as on Vercel>" > ~/agripinaa/ops/ops.env && chmod 600 ~/agripinaa/ops/ops.env'
```

The deploy script refuses to source it at any mode other than 600.

Check it end to end with `./ops/report-runner-url.sh --dry-run` on the VM (which
posts nothing), then without the flag. A 401 means the two tokens differ, a 503
means Vercel is missing `OPS_TOKEN` or the KV vars.

### Why a rotating hostname is the settled answer

The quick tunnel is the decision, not a stopgap. Nothing in the project pins a
permanent hostname: the marketplace resolves the runner base per request
(`AGENTS_BASE_URL`, then KV, then the committed default), the manifests inject
it at serve time, and the VM reports a new one within seconds of any restart.
That path is exercised on every tunnel start, so it is the tested one, whereas
a fixed hostname would be a second mechanism to keep working and a domain,
account, or tailnet policy to keep alive through judging.

Set `AGENTS_BASE_URL` only to pin the base deliberately: pointing a local web
dev server at a running Mac runner, or overriding KV during an incident. It
wins over KV, so remember to unset it afterwards or the site will keep serving
a hostname that has since rotated.

## One-time setup (already done in order)

1. `pnpm --filter @agripinaa/agents fund -- --gen` create wallets
2. `pnpm --filter @agripinaa/agents fund -- --execute` split the budget from spike-a
3. `pnpm --filter @agripinaa/agents register -- --only grid,health-factor,yield,lp-range`
   mint ERC-8004 identities (mainnet). Name the slugs: a mint is permanent, and
   the run does exactly what the flag says. An agent that already carries a
   `tokenId` or a `registrationTx` in `packages/shared/src/agents.ts`, or an
   entry in `apps/agents/data/registry.json`, is skipped, and the wallet is
   asked on-chain whether it already holds an identity before anything is
   signed, so a re-run cannot mint a second one for the same agent.

## Aleph Cloud migration (preferred)

Order matters: whichever host runs the agents owns their state (grid center, LP
position tokenId, breakers), and the Mac must stop BEFORE the VM starts
(running both = double trading).

That state lives in `apps/agents/data`, which is gitignored, so it never
travels through git. It travels by copy, and it survives a redeploy on its own:
`deploy-aleph.sh` checks out the local repository's exact `HEAD` commit in
detached mode (or the full SHA in `DEPLOY_COMMIT`), which leaves untracked files
alone and prevents a deploy from silently switching branches. With no explicit
SHA, a dirty local tree is refused so uncommitted fixes cannot be silently
omitted. The commit must already exist on the GitHub remote.

1. Create a Debian/Ubuntu instance at console.aleph.cloud (2 vCPU / 2-4 GB
   is plenty) with the deploy public key from ~/.ssh/agripinaa-aleph.pub.
   Pin its host keys before the first deploy, since that connection ships the
   wallet keys: `ssh-keyscan -p <port> <ip> >> ops/known_hosts`, review, commit.
   The deploy script checks them strictly and refuses an unknown or changed key.
2. On the Mac: `./ops/stop-agents.sh`.
3. Only when state is being handed over: seed the VM before its first deploy, so
   the runner never ticks on an empty data directory. Clone by hand, then copy
   the state in over the same pinned host keys the deploy uses.

   ```bash
   SSH="ssh -i ~/.ssh/agripinaa-aleph -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$PWD/ops/known_hosts"
   $SSH <user@host> 'git clone https://github.com/san-npm/agripinaa.git ~/agripinaa'
   rsync -av -e "$SSH" apps/agents/data/ <user@host>:agripinaa/apps/agents/data/
   ```

   The deploy script clones only when `~/agripinaa/.git` is missing, so it
   adopts this checkout rather than replacing it. On a fresh start with nothing
   to migrate, skip the whole step.
4. Provision pinned Node.js 22, pnpm 10.33.3, git, rsync, and cloudflared
   packages on the VM from trusted repositories or a prebuilt image.
5. `./ops/deploy-aleph.sh <user@host>`   # verifies tools, syncs secrets, systemd
6. Nothing: the deploy reports the tunnel URL itself once `ops/ops.env` exists
   on the VM. Confirm from the line it prints, or re-run the reporter there.

Re-running deploy-aleph.sh updates code and restarts services, and leaves the
data directory untouched. From then on agent state lives on the VM: copy it back
the same way if the agents ever move again, and take a copy before rebuilding
the instance, since nothing else holds it.
