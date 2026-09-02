# Saved-session, managed-worker, and withdrawal context dossier

## Scope and coverage

This dossier follows the dashboard paths visible in the 2026-09-02 screenshots: saved-session classification, on-chain key validity, runner liveness/registration, managed worker sweeps, and owner withdrawal/recovery. It is an orientation artifact only: it records what the code assumes and enforces, without naming vulnerabilities or recommending changes.

Reviewed surfaces:

- Web entry and cards: `apps/web/src/app/dashboard/page.tsx`, `SessionCard.tsx`, `StrategyPositionCard.tsx`, `ManagedPositionCard.tsx`.
- Web/runner seam: the three `/api/managed/[agent]/*` routes, `managed-router.ts`, `proxy-runner.ts`, `runner-url.ts`, and the matching runner handlers in `x402-server.ts`.
- Durable worker lifecycle: `runner.ts`, `managed.ts`, `managed-runner.ts`, `managed-strategy-runner.ts`, `executor.ts`, and `chassis.ts`.
- Shared/session rules: `packages/session-kit/src/{codec,persist,scope,verify}.ts` and `packages/shared/src/{agents,contracts,managed-strategies}.ts`.
- Yield recovery contract: `contracts/src/AgripinaaYieldRouter.sol`.

Focused records are under `audit-context/functions/`. Strategy-module internals (grid pricing, range selection, weight math, venue APY policy) were followed only to their lifecycle boundary; they are not re-analyzed here because the requested focus is status, stopping, worker operation, and withdrawal.

## System map

### Browser-local record and card selection

`DashboardPage.refresh` reads browser `localStorage`, correlates unfinished activation checkpoints, and keeps every saved session regardless of local `revokedAt`; the card itself supplies live status (`apps/web/src/app/dashboard/page.tsx:L38-L67`). A saved scope is rendered as:

- `ManagedPositionCard` when its allowlist resolves to exactly one active or retired yield router (`apps/web/src/app/dashboard/page.tsx:L27-L30`, `L111-L118`; `packages/shared/src/contracts.ts:L283-L301`).
- `StrategyPositionCard` when its slug has a non-yield managed-strategy definition (`apps/web/src/app/dashboard/page.tsx:L111-L118`; `packages/shared/src/managed-strategies.ts:L169-L172`).
- Otherwise `SessionCard` (`apps/web/src/app/dashboard/page.tsx:L111-L118`).

The browser record contains the account, public session key, display scope, local revocation/registration markers, and the serialized public session (`apps/web/src/lib/session-store.ts:L10-L27`). Its exact source of persistence is browser-local `agripinaa.sessions.v1`; parse/storage failures read as an empty list (`apps/web/src/lib/session-store.ts:L29-L62`).

### Authority status

Both generic and yield-managed cards derive live/invalid authority from `isSessionKeyValid`, not from `revokedAt` (`apps/web/src/components/SessionCard.tsx:L36-L58`; `apps/web/src/components/ManagedPositionCard.tsx:L134-L165`). That function hashes the saved SEC1 public key and quorum-reads KeyStore `isValidKey(account,keyId)`; false combines never-registered, expired, and revoked (`packages/session-kit/src/verify.ts:L338-L356`). With the default public RPC set, at least two fulfilled sources must agree; any disagreement or insufficient success throws (`packages/session-kit/src/verify.ts:L278-L299`). Cards map that throw to `unknown` (`apps/web/src/components/SessionCard.tsx:L43-L52`; `apps/web/src/components/ManagedPositionCard.tsx:L147-L156`).

The screenshots' outer `revoked / expired` badge and inner `agent stopped` label are therefore two displays of the same `invalid` result: `SessionCard` supplies the outer badge (`apps/web/src/components/SessionCard.tsx:L152-L159`), and `StrategyPositionCard.runnerCopy` makes invalid authority dominate runner service status (`apps/web/src/components/StrategyPositionCard.tsx:L51-L59`).

### Runner status and request path

The strategy card asks the same-origin web API for `account + router/target`, every 15 seconds, then reads account balances directly from BSC (`apps/web/src/components/StrategyPositionCard.tsx:L169-L211`). The web route validates both address shapes and proxies with a five-second timeout and no redirects (`apps/web/src/app/api/managed/[agent]/managed-status/route.ts:L6-L23`). The proxy resolves the runner base as environment override, KV value, or committed quick-tunnel default (`apps/web/src/lib/runner-url.ts:L49-L63`) and turns fetch failure into HTTP 502 (`apps/web/src/lib/proxy-runner.ts:L59-L70`). Browser parsing accepts only `ready`, `halted`, or `not-registered` on an OK response; everything else becomes `unavailable` (`apps/web/src/lib/managed-router.ts:L20-L40`, `L87-L102`).

The runner's public status handler matches a durable registry record on exact `(agent, account, first scoped target)`, reads account/global halt state, and declares `ready` only when a successful health entry is no older than 20 minutes (`apps/agents/src/x402-server.ts:L889-L951`; `apps/agents/src/managed.ts:L43-L57`). The status is `not-registered` when no matching disk record exists, `halted` when its breaker applies, `ready` only with the fresh heartbeat, and otherwise `unavailable` (`apps/agents/src/x402-server.ts:L914-L951`). Ranger's last stored NFT ID is deliberately returned even after registry pruning (`apps/agents/src/x402-server.ts:L928-L950`).

### Handoff and durable registration

The browser posts a serialized public session to `/api/managed/<agent>/manage`; it strips any signer first (`apps/web/src/lib/managed.ts:L277-L293`). The web proxy validates the slug and request size but delegates authorization validation to the runner (`apps/web/src/app/api/managed/[agent]/manage/route.ts:L9-L47`).

The runner checks account/chain/session shape, expiry, exact canonical targets/selectors/spend caps, the token-specific pinned manager key, KeyStore validity, and the smart account's exact local descriptor and permission maps (`apps/agents/src/x402-server.ts:L294-L380`). It rebuilds the stored session from canonical policy rather than retaining client-provided permission bytes (`apps/agents/src/x402-server.ts:L256-L291`, `L1003-L1018`), then atomically upserts by `(account, router)` into `<agent>.managed.json` (`apps/agents/src/x402-server.ts:L1020-L1038`; `apps/agents/src/managed.ts:L119-L145`). The browser marks its local record `registered` only after an OK runner response (`apps/web/src/lib/managed.ts:L286-L293`; `apps/web/src/components/StrategyWizard.tsx:L696-L705`).

### Process and managed-worker lifecycle

One long-lived runner process hosts all agent loops and the public HTTP server (`apps/agents/src/runner.ts:L1-L7`, `L216-L226`). Boot requires a process-exclusive disk lock, skips only explicitly unprovisioned agents, and otherwise builds per-agent durable context from wallet/state files (`apps/agents/src/runner.ts:L60-L133`, `L136-L160`). Managed mode exists for an agent only if the module is running, a managed policy/strategy exists, and a manager key set can be loaded (`apps/agents/src/runner.ts:L171-L214`).

Yield agents run `tickManagedYield` at `AGENTS_MANAGED_TICK_MS` (default five minutes); non-yield strategies use adaptive scheduling so bounded batches revisit the registry within each module's declared cadence (`apps/agents/src/runner.ts:L49-L52`, `L228-L319`; `apps/agents/src/managed-strategy-runner.ts:L72-L105`). Both sweep families:

- load the agent's durable registry and use a persistent round-robin cursor (`apps/agents/src/managed-runner.ts:L69-L80`; `apps/agents/src/managed-strategy-runner.ts:L363-L367`);
- remove entries that are expired or no longer valid on-chain (`apps/agents/src/managed-runner.ts:L88-L130`; `apps/agents/src/managed-strategy-runner.ts:L372-L389`);
- isolate state and breakers by managed account for non-yield strategies (`apps/agents/src/managed-strategy-runner.ts:L61-L69`, `L208-L240`, `L324-L353`);
- write a per-account/target health entry after a successful sweep or caught error (`apps/agents/src/managed-runner.ts:L156-L182`; `apps/agents/src/managed-strategy-runner.ts:L397-L445`).

The non-yield relay wrapper saves a `callsId` before waiting, refuses to resubmit unresolved calls, and reconciles that record on later sweeps (`apps/agents/src/managed-strategy-runner.ts:L127-L205`, `L270-L308`, `L406-L431`). That pending record lives under the account namespace inside the agent state file (`apps/agents/src/managed-strategy-runner.ts:L61-L69`, `L324-L353`; `apps/agents/src/chassis.ts:L170-L180`).

### Owner stop and withdrawal paths

Generic `SessionCard.revoke` requires passkey recovery to the exact saved account, reconstructs the serialized public session, calls the Altana revocation, and sets the local marker only after `CONFIRMED` (`apps/web/src/components/SessionCard.tsx:L60-L97`). The yield-managed card has the same confirmation rule in `doRevoke`; `ensureSessionStopped` first checks the chain, revokes when still live, or updates the local marker when already invalid (`apps/web/src/components/ManagedPositionCard.tsx:L180-L222`). Worker registry removal is asynchronous: the next sweep observes invalid authority and removes the record (`apps/agents/src/managed-runner.ts:L121-L129`; `apps/agents/src/managed-strategy-runner.ts:L381-L388`).

Only the yield-router branch exposes dashboard owner withdrawal actions. `withdrawUsdtOut` checks destination validity, reauthenticates the owner, proves the manager session stopped, reads the live position, optionally sends an admin batch of current-router approvals plus `toIdle()`, rereads idle funds, and transfers the exact idle balance to the destination (`apps/web/src/components/ManagedPositionCard.tsx:L224-L269`; `apps/web/src/lib/managed.ts:L186-L209`, `L240-L262`). `withdrawBnbOut` first proves every managed stablecoin position is below dust, retains a fixed BNB reserve, then sends the remainder (`apps/web/src/components/ManagedPositionCard.tsx:L271-L309`; `apps/web/src/lib/managed.ts:L211-L217`, `L264-L275`).

The destination is rejected if malformed, zero/reserved, equal to the strategy account, a known managed-system address, or identified as deployed bytecode by the required RPC quorum (`apps/web/src/lib/managed-pure.ts:L6-L39`; `apps/web/src/lib/managed.ts:L219-L238`). Thus the red message shown for `0x46A15...F4364` is reached by the live contract-code branch; that same address is the configured Pancake V3 position manager (`packages/shared/src/managed-strategies.ts:L15-L16`).

For yield venue funds, `toIdle()` delegates to `_collectUsdt`: debt-free receipt legs are pulled/redeemed, debt-encumbered legs are skipped, and only this call's USDT delta is returned to `msg.sender` (`contracts/src/AgripinaaYieldRouter.sol:L183-L192`, `L194-L244`). The current active router is selected from the shared manifest and its runtime code hash/version is attested before owner unwind (`apps/web/src/lib/managed.ts:L137-L150`, `L192-L208`; `packages/shared/src/contracts.ts:L47-L100`, `L103-L122`).

For non-yield `StrategyPositionCard` sessions (including Ranger and Rebalancer), the reachable card renders live position plus `SessionCard`; `SessionCard` renders finish-handoff, revoke, and forget actions only (`apps/web/src/components/StrategyPositionCard.tsx:L213-L307`; `apps/web/src/components/SessionCard.tsx:L227-L258`). No dashboard call from this branch to `sendTokenOut`, `sendNativeOut`, a Pancake unwind, or an ERC-20 transfer was found: **nothing found**. The only web callers of `sendTokenOut`/`sendNativeOut` are `ManagedPositionCard` (`apps/web/src/components/ManagedPositionCard.tsx:L14-L34`, `L224-L309`).

## Persistent state and ownership

| State | Owner / location | Writers | Readers / lifecycle meaning |
| --- | --- | --- | --- |
| Saved browser sessions | `localStorage[agripinaa.sessions.v1]` | `storeSession`, `markRegistered`, `markRevoked`, `forgetSession` (`apps/web/src/lib/session-store.ts:L29-L62`, `L117-L186`) | Dashboard card selection and recovery/revocation material. Local `revokedAt` is not live authority. |
| Activation checkpoints | Browser local storage through funding/session checkpoint modules | Activation flows | Dashboard unfinished-activation correlation (`apps/web/src/app/dashboard/page.tsx:L38-L65`). |
| On-chain session authority | KeyStore plus smart-account descriptors/permission maps | Altana/Porto grant and revoke | Browser status and runner admission/sweeps (`packages/session-kit/src/verify.ts:L338-L356`, `L433-L515`). |
| Managed registry | `apps/agents/data/<agent>.managed.json` | Public `/manage`, sweep pruning | Registration and sweep membership (`apps/agents/src/managed.ts:L76-L97`, `L126-L179`). |
| Agent/account state | `apps/agents/data/<agent>.state.json`, `kv` namespaced as `managed:<account>:*` | Modules, breakers, sweep cursor, relay reconciliation, health | Halt, rate limit, position token ID, pending calls, and public service heartbeat (`apps/agents/src/chassis.ts:L93-L125`, `L170-L219`; `apps/agents/src/managed.ts:L56-L73`). |
| Runner endpoint | `AGENTS_BASE_URL`, then KV key, then committed default | Operator route/reporter for KV | Every web-to-runner request (`apps/web/src/lib/runner-url.ts:L7-L14`, `L49-L63`). |
| User assets | User smart account as idle ERC-20/native, lending receipts, or Pancake NFT | Owner admin calls and bounded session calls | Direct client reads for dashboard; contract/venue state survives key revocation (`apps/web/src/lib/strategy-position.ts:L227-L262`; `apps/web/src/lib/managed.ts:L313-L363`). |

## Cross-cutting invariants

1. A local browser marker never grants or ends authority. Live status is derived from KeyStore; local mutation occurs only after confirmed revocation or a definitive invalid read (`apps/web/src/components/SessionCard.tsx:L36-L58`, `L73-L89`; `apps/web/src/components/ManagedPositionCard.tsx:L180-L222`).
2. `working/managing` requires both a valid key and a fresh successful runner heartbeat. A registered disk entry without recent health is not displayed as working (`apps/web/src/components/StrategyPositionCard.tsx:L51-L59`; `apps/web/src/lib/managed-router.ts:L52-L76`; `apps/agents/src/x402-server.ts:L914-L951`).
3. Managed registry admission binds an account to canonical policy and the token-specific pinned manager identity; the runner reconstructs rather than trusts session permission bytes (`apps/agents/src/x402-server.ts:L294-L380`, `L1003-L1018`).
4. Expiry/revocation prevents later manager execution and eventually removes the disk registry record; assets and account-namespaced state remain (`apps/agents/src/managed-runner.ts:L88-L130`; `apps/agents/src/managed-strategy-runner.ts:L372-L389`; `apps/agents/src/x402-server.ts:L928-L941`).
5. Yield recovery stops manager authority before unwind/transfer and sends only owner-authenticated admin calls from the exact smart account (`apps/web/src/components/ManagedPositionCard.tsx:L167-L222`, `L224-L309`).
6. Yield-router outputs return only to `msg.sender`; debt-bearing venue legs are not moved (`contracts/src/AgripinaaYieldRouter.sol:L150-L192`, `L194-L244`).
7. A managed runner write cannot be retried while its prior relay outcome is unresolved; the calls ID is durable before polling (`apps/agents/src/managed-strategy-runner.ts:L170-L205`, `L270-L308`).
8. Corrupt agent state boots globally halted instead of resetting breakers/counters (`apps/agents/src/chassis.ts:L103-L119`).

## Unenforced assumptions / `nothing found`

- Non-yield strategy recovery assumes the owner has some path outside `StrategyPositionCard` to unwind/transfer approved strategy inventory after stopping. No such dashboard action or linked recovery instruction is present in the reachable card branch: **nothing found** (`apps/web/src/components/StrategyPositionCard.tsx:L213-L307`; `apps/web/src/components/SessionCard.tsx:L227-L258`).
- A saved non-yield scope is classified using `meta.agent.slug`, while a yield scope is classified from the allowlist/router. For old browser records missing a slug, no migration/backfill in `read()` establishes the intended strategy: **nothing found** (`apps/web/src/app/dashboard/page.tsx:L27-L30`, `L111-L118`; `apps/web/src/lib/session-store.ts:L31-L58`).
- The browser assumes its saved `raw` session remains sufficient for later SDK revocation. Aside from signer scrubbing and JSON parse/deserialization, no on-load structural validation of the full raw bundle was found: **nothing found** (`apps/web/src/lib/session-store.ts:L31-L58`, `L185-L186`).
- The process supervisor/VM is assumed to preserve `apps/agents/data` across deploys. Application code persists there, but no second durable store or automatic registry reconstruction from chain exists: **nothing found** (`apps/agents/src/chassis.ts:L25-L28`, `apps/agents/src/managed.ts:L76-L97`; operational ownership is documented in `ops/launch.md:L102-L114`).
- Public status assumes the first stored call target is the mandate identity. Admission enforces canonical ordering, but direct disk mutation/corruption is not re-canonicalized by `loadManaged`; `loadManaged` only checks that deserialization yields an array: **nothing found** (`apps/agents/src/managed.ts:L80-L89`; `apps/agents/src/x402-server.ts:L204-L208`, `L914-L917`).
- `StrategyPositionCard` polls position and runner service together, but account-balance reads are direct RPC and do not prove that the runner produced or controls the displayed inventory. The UI intentionally labels balances as live account position rather than execution attribution (`apps/web/src/components/StrategyPositionCard.tsx:L169-L211`, `L253-L295`). No transaction attribution is established here: **nothing found**.
- The full-exit destination policy assumes withdrawal must target an EOA. The code explicitly rejects any address with bytecode; no contract-wallet recovery alternative is present: **nothing found** (`apps/web/src/lib/managed-pure.ts:L17-L39`; `apps/web/src/lib/managed.ts:L219-L238`).

## Open questions to carry into investigation

- Do the production web deployment, runner commit, and VM state files correspond to this working tree? Source alone cannot establish the deployed commit or disk registry contents.
- For the screenshot accounts, what exact KeyStore results do independent RPCs return for each saved public key? The screenshot supplies account balances and dates but not the public keys needed to reproduce `isSessionKeyValid`.
- Does the production runner's `/healthz` respond at the base selected by Vercel (environment, KV, or fallback), and do its `/managed-status` responses distinguish `not-registered`, `halted`, and stale/unavailable for these exact `(agent, account, target)` tuples?
- Were the Ranger/Rebalancer grants ever acknowledged by `/manage`, and, if so, are their `<agent>.managed.json` entries still present on the VM? Browser `registrationStatus` is not shown in the screenshots.
- Is `0x46A15...F4364` in the withdrawal input user-entered, browser-autofilled, or populated by a deployed revision different from this tree? Current `ManagedPositionCard` initializes `dest` to the empty string (`apps/web/src/components/ManagedPositionCard.tsx:L71-L80`), while the address is the Pancake position manager (`packages/shared/src/managed-strategies.ts:L15-L16`).
- What owner-exit behavior is intended for each non-yield strategy: plain idle token transfer, cancellation of open Ophis orders, Pancake liquidity decrease/collect, approval revocation, or a combination? The current card establishes none of these semantics.
- For the Steward withdrawal attempt, at which boundary did it stop: destination contract check, passkey/account mismatch, KeyStore quorum, revocation, current-router runtime quorum, relay execution, debt-skipped unwind, or final transfer? Each produces a distinct error path in `withdrawUsdtOut` (`apps/web/src/components/ManagedPositionCard.tsx:L224-L269`).
