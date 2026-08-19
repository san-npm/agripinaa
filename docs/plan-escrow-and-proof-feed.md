# Plan: ERC-8183 job escrow + live proof feed

Two features to take Agripinaa beyond "prove agents work" toward "pay agents
for outcomes" and "show it happening live." Both compose with what exists
(session-kit, exec-metrics, the verified-agent set, the agent runner + tunnel).

---

## Feature 1 — ERC-8183 job escrow

### What it adds
Today hiring means granting a session key and paying per call (x402). Escrow
adds the missing economic primitive: a user funds a **job** in escrow, the
agent delivers, and payment releases on approval or refunds on dispute
(optimistic window). Payment becomes outcome-linked, not just metered.

### What we build on (verified in `@altananetwork/sdk` 0.7.0, chains 56/97)
`hireErc8183Agent(session, { provider, task, budget }, { network: BNB }) -> { jobId }`
(one atomic relay intent: create + register + budget + approve + fund) ·
`getErc8183Job(BNB, jobId) -> { status: OPEN|FUNDED|SUBMITTED|COMPLETED }` ·
`getErc8183DeliverableUrl(...)` · `settleErc8183Job(session, { jobId, action: 'approve'|'dispute' })` ·
`buildClaimRefundCall(...)` · `ERC8183_ADDRESSES`, `JOB_STATUS`. Budget is in
`$U` (18 decimals). Using the **session path** caps escrow by the session's
on-chain spend limit, so it inherits session-kit's safety for free.

### Architecture
```
packages/job-kit/               NEW: typed, fail-closed wrapper over the SDK
  hire.ts        hireJob(session, {provider, task, budgetUsd})
  status.ts      getJob(jobId) -> discriminated {status, deliverableUrl?}
  settle.ts      approveJob / disputeJob / claimRefund
  persist.ts     byte-exact job record store (mirrors session-store)
apps/web/
  components/HireJobPanel.tsx   buyer UI on a verified agent profile
  app/jobs/page.tsx             "My jobs" dashboard (funded/submitted/approve/dispute)
  lib/job-store.ts              localStorage job records + on-chain status refresh
apps/agents/
  src/jobs/fulfiller.ts         seller side: runner watches for jobs, delivers
```

### Two sides, phased
- **Buyer side (ship first, highest user value):** a "Hire for a job" panel on
  verified agent profiles beside "Activate". Flow: reuse the existing passkey
  session → `hireJob(session, {provider: agentWallet, task, budgetUsd})` →
  store the job → a `/jobs` dashboard polls `getErc8183Job` for status → shows
  the deliverable URL on `SUBMITTED` → `Approve` (release) or `Dispute` (refund
  after window). This is one signature on top of the session the user already
  has, and the whole state machine is on-chain.
- **Seller side (one agent first):** the runner adds a `fulfiller` loop that
  polls for jobs where `provider == agent wallet`, does the work, and calls the
  SDK submit with a deliverable. Best first fulfiller: **Guardian** with a task
  like "audit this Aave position and recommend an action" (it already reads
  `getUserAccountData`), producing a signed JSON deliverable hosted at a stable
  URL. The `apps/acp-seller` scaffold in `~/ophis` is the pattern to port.

### Milestones + acceptance
1. **Spike (testnet 97):** hire a job to a test provider, poll to `FUNDED`,
   submit a deliverable, `approve`, confirm funds released; then `dispute` +
   `claimRefund` on a second job. Record go/no-go on the atomic relay intent
   and `$U` availability. (Mirror the Spike A/B discipline.)
2. `job-kit` wrapper + unit tests (fail-closed budget, status discriminants,
   byte-exact persist).
3. Buyer UI: `HireJobPanel` + `/jobs` dashboard, toasts on hire/approve/dispute.
4. Guardian fulfiller: one real job end-to-end on testnet, then mainnet with a
   tiny budget; deliverable + approve round-trip, tx links on the job card.
5. Docs + a `Proof of Execution` row linking the escrow job on the agent
   profile.

### Risks
- Verify `ERC8183_ADDRESSES` on 56 on-chain before real funds (probe like the
  agent addresses were).
- `$U` (United Stables) balance for budgets; confirm faucet/route on testnet.
- Dispute-window timing must be surfaced clearly in the UI so a user does not
  approve prematurely.
- Keep escrow amounts tiny on mainnet (a few cents), like the agent capital.

---

## Feature 2 — Live proof feed

### What it adds
A real-time stream of verified agents' on-chain actions, each with its
receipt/tx, so a visitor sees the marketplace working: "Grid filled WBNB→USDT
+41 bps · 12s ago", "Guardian repaid 0.3 USDT, HF 1.28→1.60 · 2m ago". Ambient,
self-verifying credibility.

### Data source (reuse what exists, no new storage)
The agent runner already writes a structured **JSONL event log** per agent on
the VM (`apps/agents/data/*.log.jsonl`), and it is already exposed behind the
cloudflared tunnel (the x402 server). The clean path:

```
apps/agents/src/x402-server.ts   add GET /proof (no paywall): last N labeled
                                 events across agents, newest first, from the
                                 JSONL tail — {agent, kind, summary, txHash?,
                                 surplusBps?, hf?, at}
apps/web/
  app/api/proof/route.ts         server route: fetch the tunnel /proof,
                                 revalidate ~15s, normalize + cache
  components/ProofFeed.tsx        client: poll /api/proof, render a live stream
                                 with staggered fade+blur entrance (transitions.dev)
  app/proof/page.tsx             full-page feed; a compact 5-item version on home
```
No Vercel KV needed: the runner is the source of truth and already persists
events. On-chain Ophis trades (`exec-metrics`) provide a **backfill** so the
feed is never empty on cold start, and give each trade its surplus + settlement
tx.

### Event shape
`ProofEvent = { id, agent: '269703'..., agentName, category, kind: 'trade'|'repair'|'rotate'|'rebalance'|'mint', summary, txHash?, surplusBps?, hf?, at }`.
The runner already logs these facts (grid `trade-submitted` with orderUid, HF
`repair-done` with tx, yield `supply`, lp `minted`/`range-check`); the `/proof`
handler maps log events to `ProofEvent`s and enriches trades with a BscScan +
Ophis explorer link.

### UI
A vertical feed: agent duotone icon, a one-line summary, a semantic badge
(surplus green / repair amber / rotate violet), a relative timestamp, and a tx
link. New events slide in from the bottom with the toast-style motion; a live
pulse dot in the header. A trimmed 5-item "Live activity" block on the home
page under the stats, linking to the full `/proof` page.

### Milestones + acceptance
1. `GET /proof` on the runner returning the last ~40 mapped events (verify over
   the tunnel).
2. `/api/proof` route (cached 15s) + `ProofFeed` component; home block + `/proof`
   page.
3. On-chain backfill from `exec-metrics` so a cold load shows the last trades
   with surplus + tx.
4. Live update (poll 15s; optional SSE later), reduced-motion respected,
   empty/loading states.

### Risks
- The tunnel URL changes on restart — the `/api/proof` route reads it from the
  same env the manifests use, so it stays in one place.
- Rate/size: cap `/proof` to a bounded tail; the web route caches so agent load
  stays flat.
- Privacy: only the four verified agent wallets are surfaced; no user data.

---

## Sequencing
Ship the **proof feed first** (2-3 days, no new on-chain risk, immediate
credibility for judging), then **ERC-8183 escrow** (starts with a testnet spike,
then buyer UI, then the Guardian fulfiller). Both are ETHOnline-friendly and
extend the existing seams without a rewrite.
