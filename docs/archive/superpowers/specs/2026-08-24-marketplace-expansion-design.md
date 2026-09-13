# Agripinaa marketplace expansion, design spec

Date: 2026-08-24. Target: everything live and hardened before Sep 9 2026 (submission),
stable through Sep 23 (end of judging window). Owner: Clément. Branch: `marketplace-expansion`.

## Goal

Turn Agripinaa from a portfolio of 4 house agents plus a thin index into a marketplace a
judge can browse, compare, and act in, scored against the three published criteria:
Functionality (end-to-end hire journey, no dead ends), Data Quality (live data beyond
basic counts), Agent Diversity (equal surfacing of the four mandated categories: grid,
health-factor, yield, rebalancing). The brief warns explicitly against submitting
"a portfolio of individual agents".

Decisions already made with the owner:

- Scope: both a deeper in-house lineup AND third-party onboarding.
- Onboarding shape: claim-your-agent flow (no full registration wizard).
- Approach: full sweep, dependency-ordered (approved 2026-08-24).
- New in-house agents: 4, one per hub.
- Runner endpoint: self-healing quick tunnel (no custom domain).
- Agent names require the owner's explicit sign-off before any on-chain registration.

## Section 1: Harden the judge path (build first)

### 1.1 Self-healing runner endpoint

Problem: the x402/runner base URL is an ephemeral trycloudflare quick-tunnel URL,
committed inside all four `apps/web/public/manifests/*.json` and used as fallback by
`apps/web/src/lib/agents-endpoint.ts` and `proof.ts`. A tunnel restart breaks the x402
endpoints, the proof feed, and the managed-funds activation step until a manual script
run plus commit plus Vercel redeploy.

Design:

- Serve manifests dynamically: replace the static files with a route handler at the SAME
  paths (`/manifests/<name>.json`) that renders the manifest content server-side and
  injects the current runner base URL at request time. Initially the content comes from
  the existing per-agent JSON moved server-side; once the shared agent config lands
  (section 2.1) the route reads from it. On-chain tokenURIs do not change.
- Store the current runner base URL in Vercel KV under one key. Read order in the web
  app: `AGENTS_BASE_URL` env (manual override) -> KV value -> none (UI shows a candid
  "runner offline" state rather than fake data).
- VM self-report: the tunnel systemd unit (or a small wrapper) extracts the assigned
  quick-tunnel URL on start and POSTs it to `/api/ops/runner-url`, authenticated with a
  shared bearer token (`OPS_TOKEN` env on both ends). The route validates the URL shape
  (https, *.trycloudflare.com or any https origin) and writes KV.
- `ops/set-x402-endpoint.sh` becomes a fallback tool, no longer the primary path.

Error handling: if KV is empty or the probe of the stored URL fails, agent pages render
status panels in an explicit degraded state ("runner offline, on-chain data still live")
instead of hanging on "connecting...".

### 1.2 First-paint correctness

- Stats strip (`apps/web/src/app/page.tsx`): server-render with the keyed, BSC-scoped
  total from 8004scan (label it "on BSC"). Never ship HTML that claims 0 agents. Cache
  with the existing `use cache` + `cacheLife` pattern; fall back to the snapshot count
  with an "as of <date>" stamp when the API is unavailable.
- Proof feed: server-render initial rows from the Ophis settlement backfill so the page
  and the home section are populated at first paint; the 15s client polling takes over
  after hydration.

### 1.3 Trust-number consistency

- One source of score truth per agent: the card (`AgentCard.tsx`) and the detail page
  must render the same value for the same agent (first-party: on-chain
  `ReputationRegistry.getSummary()`; third-party: 8004scan trust data, provenance-labeled).
- Fix the "1x402" concatenation render bug on cards.
- Fix the flagship agent's empty "Attested" field on the detail page.
- Carry directory names through to detail pages (no "Agent #<id>" regression when the
  list view already had a name).

### 1.4 Remove dead ends

- Registry agents with no live runner: primary CTA becomes "Inspect on-chain identity"
  (identity, owner, registration, feedback). "Activate" appears only for agents with a
  live-probed endpoint (first-party, or claimed + probed per section 3).
- If a judge deep-links into the activation wizard for a non-activatable agent, show a
  plain warning gate before any wallet creation step.

### 1.5 Public-launch basics

`not-found.tsx`, `error.tsx`, `loading.tsx`, `robots.ts`, `sitemap.ts`, OG image,
`generateMetadata` on agent and category pages, fix the 404ing manifest `image` URL,
replace the create-next-app README with the pitch, architecture summary, and run
instructions.

## Section 2: Add-agent scaffold, then 4 new agents

### 2.1 Single agent registry

Problem: per-agent names/ids/proof refs are hand-edited across at least 7 files
(`runner.ts` ALL, `fund.ts` WALLET_NAMES/PLAN, `register.ts` AGENT_NAMES, `attest.ts`,
`ops/set-x402-endpoint.sh`, `apps/web/src/lib/data.ts` PINNED_AGENT_IDS,
`apps/web/src/lib/verified.ts` VERIFIED_AGENTS), with no error when one edit is missed.

Design: one config module in `packages/shared` (extending the existing `proof.ts`
agent list) holding per agent: slug, display name, category, ERC-8004 token id, wallet
file name, funding plan entry, manifest fields (description, capabilities, venue, pair,
safety caps, x402 price), registration/attestation tx refs, managed-funds flag. All 7
consumers read from it. A `pnpm new-agent <slug>` generator scaffolds the config entry,
wallet placeholder, strategy module stub, and test stub.

Supporting fixes, all pre-registration:

- `fund.ts --only <slug>` so funding a new agent cannot re-send to funded wallets.
- Registration preflight: HTTP-check that the manifest URL resolves (dynamic route must
  be deployed) before minting; abort otherwise. Today a premature registration mints a
  permanent tokenURI that 404s.
- Attestation automation: harvest proof refs (settlement tx, order uid) from the agent's
  JSONL log instead of manual BscScan collection; `attest.ts` consumes them and writes
  the tx refs back into the shared config data.

### 2.2 The four new agents

All reuse existing, tested logic. Names TBD pending owner sign-off; slugs below are
working placeholders only.

| Slug (placeholder) | Hub | Strategy | Reuse |
|---|---|---|---|
| grid-b | grid | Second grid on a different PancakeSwap V3 pair (candidate: WBNB/USDC), wider level spacing, different clip size, same Ophis execution, same breakers | `grid.ts` near-total |
| venus-guardian | health-factor | Venus borrow-position guardian on a self-demo position: monitors account liquidity, repays toward target when it degrades | `health-factor.ts` planner pattern (`planRepayAmounts` equivalent, unit-tested, Venus `getAccountLiquidity` semantics) |
| weight-rebalancer | rebalancing | Holds 50/50 value split WBNB/USDT; when drift exceeds a band, restores weights with one Ophis swap | inventory-rebalance logic from `lp-range.ts` |
| yield-b | yield | Conservative rotator on the SAME drain-proof router: longer hysteresis (larger bps threshold, more confirmation checks), fewer rotations | `yield.ts` + managed-funds wiring |

`yield-b` is the only agent needing managed-funds wiring: its own master manager
session key (`wallets/agent-yield-b-session.json`), per-token key derivation (existing
`manager-key.ts`), and `MANAGED_AGENTS` in `runner.ts` becoming config-driven. Result:
two agents competing for user deposits on the same router, which converts the flagship
feature into a marketplace choice.

Costs and operations (owner actions marked):

- Gas ~0.0012-0.0015 BNB per agent, capital 1.5-3 USDT each plus small WBNB for grid-b
  and weight-rebalancer. OWNER: top up `spike-a` treasury if short (verify balances first).
- OWNER: sign off the four display names before `register.ts` runs.
- Registration target ~Sep 1 to allow a week of live burn-in and visible track record.

### 2.3 Track-record thickening

- Modestly raise activity caps on existing agents (example: grid 12 -> 18 trades/day;
  every cap and breaker stays in place). Present exact numbers to the owner at
  implementation time.
- Per-agent performance panel on first-party detail pages: cumulative fill count,
  average surplus, realized P&L, computed from `exec-metrics` + settlement receipts.

## Section 3: Claim-your-agent flow

Route: `/agent/56/<tokenId>/claim` from a "Claim this agent" affordance on unclaimed
registry agent pages.

Flow:

1. Connect wallet (plain EOA connect; no smart-account requirement for claiming).
2. Ownership check: `IdentityRegistry.ownerOf(tokenId)` equals connected address.
3. Sign an EIP-712 typed message over {chainId, tokenId, fields, timestamp}.
4. Submit enrichment fields: description, category (one of the 4 hub slugs or "other"),
   website, optional x402/runner endpoint.
5. Server verifies signature recovers the owner address, re-checks `ownerOf` on-chain,
   stores {fields, signature, signer, timestamp} in Vercel KV keyed by chainId:tokenId.

Display: enriched listings render owner-provided fields with an "owner-provided"
provenance label (consistent with the existing FreshnessStamp/source-label pattern).
Claimed category feeds hub listing. We write nothing on-chain; the UI links owners to
updating their tokenURI for permanent metadata.

Endpoint liveness: a supplied endpoint is probed (GET, 5s timeout, via the existing
SSRF-safe fetch in `packages/shared/src/ssrf.ts`). Responsive agents get a "live" badge
and the session-wizard activation path; unresponsive ones stay in inspect-only mode.
Probes re-run on a schedule (same cron as section 4) so badges decay when endpoints die.

Abuse surface: claims are signature-gated to the on-chain owner; a transferred identity
invalidates prior claims (re-check `ownerOf` at render/refresh time, drop stale claims).
Free-text fields are length-capped and rendered as text, never HTML. v1 supports EOA
owners only (ECDSA recovery); identities owned by contract wallets (ERC-1271) see a
"claiming from a contract wallet is not supported yet" notice rather than a broken flow.

## Section 4: Data quality and discovery

- Re-seed `packages/agent-index/data/agents-56.json` via the keyed 8004scan API
  (server-side chain filter works on the keyed path) with a larger, classified set.
- Scheduled refresh: Vercel cron hitting an internal route that re-seeds KV-backed index
  data and re-runs liveness probes. The committed snapshot remains the offline floor.
- Classification: run `classify.ts` keywords plus any 8004scan category metadata over
  the full fetched set (not per-100-page client-side), so hubs list third-party agents
  under an "unclaimed" label alongside first-party and claimed agents.
- Discovery UI on `/agents`: search box (name/description), category + liveness + claimed
  filters, cursor pagination wired to the existing `/api/index/agents` cursor support.
  Remove the 45-card hard cap.
- Cross-page dedupe: run `rankAndDedupe` over the accumulated server-side set, not per
  page.
- Stat integrity: BSC-scoped totals everywhere (the public /stats endpoint ignores
  chain_id; use the keyed path).
- Positioning: present the number as curation ("N live-probed, classified, activatable
  agents out of ~258k BSC registrations"), not coverage.
- Rate-limit budget: keyed tier is 180 req/min, 20k/day. All keyed calls go through the
  cached data layer; the cron pre-warms; judge traffic must not fan out per-visitor.

## Section 5: Show the money

- Public `/funds` page (no wallet needed): both router addresses (USDT
  0xD18375cA..., USDC 0xb0817946...) with BscScan links, live TVL per token, full
  `Rotated` event history (existing `readRotationHistory`), and a plain-language security
  explainer: zero-argument entrypoints, recipients hardcoded to msg.sender, delta
  accounting, fuzzing invariants, no owner, non-upgradeable.
- Execution-quality leaderboard page: agents ranked on settlement-derived metrics
  (`exec-metrics`), covering first-party agents and any claimed agent with Ophis
  receipts. Ranking methodology stated on the page. This is the surface no
  feedback-event-based competitor can replicate.
- x402 demo interaction on first-party agent pages: a "query live status (0.05 USDT via
  x402)" button against the existing paywalled endpoint, with a wallet-less preview of
  what the paid response contains. The brief names x402 as the payment facilitator;
  today the badge has no clickable counterpart.

## Section 6: Positioning and docs

- Architecture diagram (marketplace, index sources, agents/VM, router, ERC-8004,
  Ophis) in the README.
- Security write-up of the router: the audit finding L-1 fix, the fuzz invariants, the
  session-scoping fail-closed rules. Currently this lives only in commit messages and
  test names.
- Update the fee disclosure to the post-2026-08-11 Ophis fee schedule (1 bp base +
  price-improvement capture).
- Draft the TermiX Agent Advantage Report (3 tasks with/without an agent, at least one
  trading, time/cost/quality with outputs) for the stackable partner prize. OWNER:
  reviews before submission.

## Testing

- New strategy modules: pure-logic cores with unit tests, matching the existing pattern
  (planner math, band/hysteresis decisions), plus the existing chassis breakers.
- Claim flow: unit tests for signature verification, ownership re-check, field caps;
  SSRF tests already exist for the probe path.
- Web: e2e smoke of the exact judge path (land -> category -> compare two agents ->
  detail -> inspect/activate gate), plus first-paint assertions (no zero-stat HTML,
  proof feed non-empty).
- Contracts: unchanged (no contract changes in this scope); fork + fuzz suites keep
  running as-is.
- Burn-in: new agents run on the VM for several days pre-Sep 9; proof feed and
  attestations checked end to end.

## Sequencing and de-risking

Strict order: Section 1 -> Section 2 -> Sections 3+4 in parallel -> 5 -> 6. Every
completed section stands alone if later ones slip. Registration of new agents no later
than ~Sep 1. Site and agents must stay untouched-stable Sep 9-23 (judging window);
feature freeze Sep 8.

## Out of scope

Full third-party registration wizard, new router venues/tokens/chains, ValidationRegistry
integration (not deployed on any chain), testnet deployments, mobile apps, and the
demo video/submission mechanics.

## Open items owned by Clément

- Sign off the four agent display names (before ~Sep 1 registration).
- Treasury top-up if `spike-a` is short for funding the four wallets.
- Approve the exact raised activity caps when presented.
- Review the TermiX report draft.
