# Dashboard and saved-session status functions

## `DashboardPage.refresh` in `apps/web/src/app/dashboard/page.tsx` (L38-L67)

**Purpose:** Materializes browser-local sessions and unfinished activation checkpoints into the dashboard model.

**Inputs & Assumptions:**
- `localStorage` through `listStoredSessions`: untrusted browser state; parse failure becomes no sessions (`apps/web/src/lib/session-store.ts:L31-L65`).
- Funding checkpoints: browser-local recovery state.
- Assumes record timestamps are parseable for checkpoint correlation. `Date.parse` results are compared, but this function does not validate them (`apps/web/src/app/dashboard/page.tsx:L47-L57`); establishing validation: **nothing found**.

**Outputs & Effects:** Sets React state to all saved sessions plus activation checkpoints that have no completed, following session (`L38-L67`). No chain or runner read occurs here.

**Block-by-Block:**

```tsx
// L38-L46
const sessions = listStoredSessions();
const matchingSessions = sessions.filter(/* chain + account + agent + local not-revoked */);
```

- **What:** Joins local session and checkpoint state.
- **Why here:** The dashboard renders once after client mount because local storage is unavailable during server render (`L68-L71`).
- **Assumes:** `revokedAt === null` is adequate only for checkpoint correlation, not authority.
- **Establishes:** A revoked local record will not satisfy a pending activation.
- **Depended on by:** `PendingActivationCard` and saved-card selection (`L73-L128`).

```tsx
// L52-L65
const completedSession = ... registrationStatus === 'registered' ...;
const pendingSession = ... registrationStatus === 'pending' && expiresAt > now ...;
```

- **What:** Suppresses checkpoints already handed off and links still-live pending ones.
- **Why here:** Keeps funding/session recovery separate from the later live-authority check.
- **Assumes:** Browser registration marker reflects the runner acknowledgment made during activation. It is set only after `registerManaged` succeeds (`apps/web/src/components/StrategyWizard.tsx:L696-L705`).
- **Establishes:** `pending` display does not survive local expiry.
- **Depended on by:** Dashboard recovery copy.

**Cross-Function Dependencies:**
- `listStoredSessions` (internal): supplies sorted, signer-scrubbed local records (`apps/web/src/lib/session-store.ts:L31-L65`).
- `agentBySlug` / `managedStrategyFor`: resolve browser strings against own-key/shared strategy registries (`packages/shared/src/agents.ts:L599-L608`; `packages/shared/src/managed-strategies.ts:L169-L172`).
- Shared state: browser session and funding checkpoint storage.

**Open Questions:**
- Whether production browser records predate current `slug` and `registrationStatus` fields.

---

## `SessionCard.check` effect in `apps/web/src/components/SessionCard.tsx` (L36-L58)

**Purpose:** Converts the saved public key/account into a live authority state for display and action gating.

**Inputs & Assumptions:**
- `meta.account`, `meta.publicKey`, `meta.chainId`: untrusted browser-local fields.
- Assumes any syntactically present public key can be passed to `isSessionKeyValid`; local shape validation here: **nothing found** (`L39-L48`).

**Outputs & Effects:** Sets `validity` to `valid`, `invalid`, or `unknown`; avoids setting state after unmount (`L36-L58`).

**Block-by-Block:**

```tsx
// L39-L52
if (!meta.publicKey || meta.account === 'unknown') setValidity('unknown');
else isSessionKeyValid(...).then(valid => valid ? 'valid' : 'invalid').catch(() => 'unknown');
```

- **What:** Separates definitive negative authority from unavailable verification.
- **Why here:** The badge and revoke button consume this state (`L152-L159`, `L239-L247`).
- **Assumes:** KeyStore's `isValidKey` is the authoritative expiry/revocation predicate, documented in `verify.ts:L338-L356`.
- **Establishes:** RPC failure never displays a session as revoked/expired.
- **Depended on by:** Badge, position render callback, revoke availability, and finish-handoff gating.

**Cross-Function Dependencies:**
- `isSessionKeyValid` (external-source-available): requires quorum agreement over a KeyStore read (`packages/session-kit/src/verify.ts:L278-L299`, `L343-L356`).
- Callers: React lifecycle only.
- Shared state: none written outside component state.

**Open Questions:**
- Which default BSC RPCs were reachable when the screenshot returned `invalid`; source does not preserve read provenance.

---

## `runnerCopy` in `apps/web/src/components/StrategyPositionCard.tsx` (L51-L60)

**Purpose:** Combines session authority and runner service into the inner `agent ...` label.

**Inputs & Assumptions:**
- `validity`: result of `SessionCard`'s KeyStore check.
- `status`: parsed public runner response.

**Outputs & Effects:** Pure label/style mapping; no writes.

**Block-by-Block:**

```tsx
// L52-L59
if (validity === 'invalid') return { label: 'agent stopped', ... };
...
if (status === 'ready') return { label: 'agent working', ... };
```

- **What:** Makes checking/invalid/unknown authority dominate runner state, then distinguishes ready/halted/unregistered/unavailable.
- **Why here:** Prevents a stale positive runner report from overriding stopped authority.
- **Assumes:** `ready` has already been parsed from a successful response (`apps/web/src/lib/managed-router.ts:L20-L40`).
- **Establishes:** `agent working` is reachable only for `valid + ready`.
- **Depended on by:** The live-position header (`apps/web/src/components/StrategyPositionCard.tsx:L222-L239`).

**Cross-Function Dependencies:** No calls.

**Open Questions:** None.

---

## `StrategyPositionCard.load` effect in `apps/web/src/components/StrategyPositionCard.tsx` (L169-L211)

**Purpose:** Polls runner telemetry and direct chain position data for non-yield strategies.

**Inputs & Assumptions:**
- Saved account/slug and shared strategy definition.
- First call-scope target is treated as the status identity (`L164-L165`, `L177-L179`). Admission canonicalization establishes this for current records (`apps/agents/src/x402-server.ts:L317-L335`).
- Assumes one in-component boolean prevents overlapping polls (`L172-L175`).

**Outputs & Effects:** Updates runner service, Ranger token ID, position, and load-error state; polls every 15 seconds (`L177-L210`).

**Block-by-Block:**

```tsx
// L177-L188
const snapshot = await readManagedRunnerSnapshot(slug, account, target);
const positionTokenId = effectiveManagedPositionTokenId(snapshot, cached);
```

- **What:** Reads service and the exact Ranger NFT ID; caches the ID only across fetch failures.
- **Why here:** The NFT ID is needed by the later direct position read.
- **Assumes:** A reachable runner's missing ID is authoritative and clears the cache (`apps/web/src/lib/managed-router.ts:L43-L50`).
- **Establishes:** Runner service and NFT identity are from one response.
- **Depended on by:** `readStrategyAccountPosition` and `RangerDetails`.

```tsx
// L189-L202
const next = await readStrategyAccountPosition(...);
setPosition(next); setLoadError(false);
```

- **What:** Reads native and token balances, plus Ranger NFT state when applicable.
- **Why here:** Account assets are direct on-chain facts and remain meaningful when the agent is stopped.
- **Assumes:** One public client read set represents a sufficiently coherent latest view; no block number is pinned across the calls: **nothing found** (`apps/web/src/lib/strategy-position.ts:L227-L262`).
- **Establishes:** On failure, stale data is hidden by `strategyPositionViewState` (`apps/web/src/lib/strategy-position.ts:L65-L74`).
- **Depended on by:** Position cards at `StrategyPositionCard.tsx:L241-L302`.

**Cross-Function Dependencies:**
- `readManagedRunnerSnapshot` (web route + external runner): fail-closes to unavailable (`apps/web/src/lib/managed-router.ts:L87-L102`).
- `readStrategyAccountPosition` (external chain reads): reads account assets and optional Pancake state (`apps/web/src/lib/strategy-position.ts:L227-L262`).
- `SessionCard` is the caller/wrapper that independently supplies authority (`apps/web/src/components/StrategyPositionCard.tsx:L213-L223`).

**Open Questions:**
- Why the screenshot accounts' KeyStore reads are invalid while their account asset reads succeed.
- No owner asset-exit call is reachable from this component or its `SessionCard` wrapper: **nothing found** (`StrategyPositionCard.tsx:L213-L307`; `SessionCard.tsx:L227-L258`).
