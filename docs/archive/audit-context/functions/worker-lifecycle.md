# Managed worker lifecycle functions

## `main` in `apps/agents/src/runner.ts` (L136-L355)

**Purpose:** Boots the one agent process, publishes its HTTP surface, and schedules own-capital and managed-account loops.

**Inputs & Assumptions:**
- Wallet files, facilitator file, manager-key files, data directory: host-local trusted configuration/secrets.
- Process environment for port/cadence/ops token.
- Shared agent registry and strategy/policy definitions.
- Assumes a process supervisor restarts a crashed runner; in-code restart: **nothing found**.

**Outputs & Effects:** Acquires the run lock, opens contexts/server, starts immediate and repeating loops, writes logs/state, and exits nonzero on fatal boot error (`runner.ts:L136-L223`, `L228-L355`).

**Block-by-Block:**

```ts
// L136-L160
assertModulesRegistered(ALL); acquireRunLock();
for modules: buildContext; agents.set; log boot;
```

- **What:** Establishes a single process and per-agent durable context.
- **Why here:** HTTP publication and loops require consistent modules/state.
- **Assumes:** A missing wallet is safe to skip only for registry-declared unprovisioned records (`L145-L157`).
- **Establishes:** `agents` contains only contexts that booted successfully.
- **Depended on by:** Manager setup and HTTP routes.

```ts
// L171-L214
for managed agents: require running agent + policy/strategy + manager key set;
publish token identities; populate yield/strategy key maps;
```

- **What:** Determines which agents support managed endpoints/workers during this process.
- **Why here:** Browser must grant to exactly the private key held by this runtime.
- **Assumes:** Pinned public addresses match the loaded key set; separate verification is performed by manager-key provisioning/tests, but no explicit assertion appears in this loop: **nothing found**.
- **Establishes:** `managers` and scheduled key maps share the same key objects.
- **Depended on by:** `startX402Server`, `tickManagedYield`, and `tickManagedStrategy`.

```ts
// L228-L319
start immediate managed loops; use fixed yield cadence and adaptive non-yield cadence;
```

- **What:** Runs bounded account sweeps without overlap.
- **Why here:** User deposits should deploy promptly and full registries remain revisitable.
- **Assumes:** `running` in one process plus the run lock excludes duplicate local work.
- **Establishes:** A thrown sweep is logged and later schedules continue.
- **Depended on by:** Public health heartbeat and automation.

**Cross-Function Dependencies:**
- `acquireRunLock` uses exclusive file creation and process liveness (`runner.ts:L60-L133`).
- `buildContext` loads fail-closed disk state and guarded clients (`apps/agents/src/chassis.ts:L151-L256`).
- `tickManagedYield` / `tickManagedStrategy` perform per-entry authority and execution work.

**Open Questions:**
- Current supervisor status, runner PID/lock state, and last fatal log on the production VM.
- Whether the tunnel unit is healthy independently of the runner unit.

---

## `loadManaged`, `upsertManaged`, and `removeManagedEntry` in `apps/agents/src/managed.ts` (L80-L97, L119-L145, L160-L179)

**Purpose:** Durable membership store for user mandates.

**Inputs & Assumptions:**
- Agent name and disk file contents.
- Entry shape is expected to have been canonicalized by `/manage`; `loadManaged` validates only the top-level array: **nothing found** (`managed.ts:L84-L89`).

**Outputs & Effects:** Loads, atomically replaces/upserts, or removes exact `(account, router, publicKey, expiry)` entries (`L84-L97`, `L126-L145`, `L160-L179`).

**Block-by-Block:**

```ts
// L84-L97
missing file => [];
deserializeSession(file); array ? parsed : [];
save via writeStateFile;
```

- **What:** Treats absence/non-array as empty and writes through temp+fsync+rename.
- **Why here:** Registries survive runner restarts without partial-file truncation.
- **Assumes:** Deserialization errors may propagate; unlike general state, no corrupt-file quarantine occurs here: **nothing found**.
- **Establishes:** Successful saves are atomic at file/directory boundary (`apps/agents/src/chassis.ts:L50-L74`).
- **Depended on by:** Status, admission conflicts, and sweeps.

```ts
// L126-L145
key by account + normalized router; enforce 300-entry admission ceiling; replace and save;
```

- **What:** Allows USDT/USDC mandates together but replaces a regrant for one router.
- **Why here:** A token-specific mandate must not overwrite the other token.
- **Assumes:** `routerKey` can normalize a usable first concrete target (`managed.ts:L99-L117`).
- **Establishes:** At most one record per account/router after this writer.
- **Depended on by:** Public status and sweeps.

```ts
// L160-L179
filter exact account/router/publicKey/expiry; save;
```

- **What:** Removes only the stale mandate observed by a sweep.
- **Why here:** A newer replacement or other token mandate survives.
- **Assumes:** Session fields are structurally present.
- **Establishes:** Successful prune persists across restart.
- **Depended on by:** Expiry/revocation handling.

**Cross-Function Dependencies:**
- `serializeSession/deserializeSession` preserve bigint permission caps (`packages/session-kit/src/codec.ts:L7-L20`).
- `writeStateFile` supplies durability/mode (`apps/agents/src/chassis.ts:L45-L74`).

**Open Questions:**
- Actual production registry contents and whether any file is malformed or absent after VM migration.

---

## `tickManagedYield` in `apps/agents/src/managed-runner.ts` (L58-L190)

**Purpose:** Services yield-router mandates and records a public health heartbeat.

**Inputs & Assumptions:**
- Agent context, Altana client, manager keys, explicit policy.
- Durable managed entries; untrusted insofar as disk can be stale/corrupt.

**Outputs & Effects:** Prunes dead mandates, runs policies, sends bounded router calls, writes cursor/health/logs, and returns counts (`L69-L190`).

**Block-by-Block:**

```ts
// L71-L80
allEntries = loadManaged; batch = managedSweepBatch(cursor); persist next cursor before reads;
```

- **What:** Bounded round-robin selection.
- **Why here:** One bad entry cannot permanently pin later ones; a crash may delay only the current batch.
- **Assumes:** Cursor state writes succeed before RPC.
- **Establishes:** Next sweep advances.
- **Depended on by:** Worker pool.

```ts
// L89-L130
prune expired; classify retired recovery-only; attest active router; read KeyStore; prune invalid;
```

- **What:** Establishes executable live authority and eligible router before constructing a signer.
- **Why here:** No action should be sent for expired/revoked/retired/unattested state.
- **Assumes:** Recovery-only records remain in the registry intentionally (`L101-L106`).
- **Establishes:** Later execution uses a live active v3 router entry.
- **Depended on by:** Manager-key selection and `managedExecutor`.

```ts
// L131-L169
resolve token key; wrap executor; run policy; write healthAfterManagedTick;
```

- **What:** Executes policy and records ready/error.
- **Why here:** Public status should reflect the actual per-account sweep.
- **Assumes:** Read-only ticks can preserve an execution-recovery error (`managed-runner.ts:L33-L55`).
- **Establishes:** Fresh ready only after a completed non-error tick.
- **Depended on by:** `/managed-status`.

**Cross-Function Dependencies:**
- `isDebtCompleteRouterRuntime` (external chain reads), `isSessionKeyValid` (KeyStore quorum), `managedYieldTick` (strategy), `managedExecutor` (Altana session execution).
- Shared state: registry file and agent state cursor/health.

**Open Questions:**
- Latest `managed-error`, `managed-pruned`, and health reason for the affected Steward account.

---

## `tickManagedStrategy` in `apps/agents/src/managed-strategy-runner.ts` (L356-L450)

**Purpose:** Services non-yield managed sessions such as Ranger and Rebalancer with account-isolated state.

**Inputs & Assumptions:**
- Base context/module/client/one USDT manager key.
- Assumes current non-yield strategies use the USDT manager identity; boot selects it at `runner.ts:L261-L269`, while admission returns `managerToken: 'USDT'` at `x402-server.ts:L184-L190`.

**Outputs & Effects:** Prunes, reconciles pending relay work, runs module ticks, updates health, logs errors, and returns counts (`L363-L450`).

**Block-by-Block:**

```ts
// L363-L389
global halt short-circuit; load/batch; prune expiry and invalid KeyStore sessions;
```

- **What:** Prevents work under a shared integrity halt or dead mandate.
- **Why here:** Authority check precedes signer construction.
- **Assumes:** Local account-scoped halt should not stop other accounts.
- **Establishes:** Each processed entry has target and live KeyStore registration.
- **Depended on by:** Context construction.

```ts
// L390-L421
build account context; check account/global breaker; reconcile durable pending write; repair module bookkeeping;
```

- **What:** Recreates session execution and resolves previous ambiguous submissions.
- **Why here:** A module must not issue later/repeated work while an earlier call is unresolved.
- **Assumes:** `recoverConfirmedWrite` is implemented where module bookkeeping needs it; otherwise confirmed record remains until later handling.
- **Establishes:** Module starts with no unresolved pending relay outcome.
- **Depended on by:** `module.tick`.

```ts
// L422-L445
tick; clear reconciled confirmation; write ready health; catch and write error health;
```

- **What:** Runs one strategy iteration and publishes its health.
- **Why here:** Status reflects the per-account path rather than demo-wallet status.
- **Assumes:** A successful read-only tick demonstrates readiness.
- **Establishes:** Fresh ready or error timestamp for the status handler.
- **Depended on by:** `/managed-status`.

**Cross-Function Dependencies:**
- `buildManagedStrategyContext` validates manager public key and creates namespaced state/wallet (`managed-strategy-runner.ts:L324-L353`).
- `reconcilePendingWrite` reads the external relay and never resubmits unresolved work (`managed-strategy-runner.ts:L170-L205`).
- Module `tick` is strategy-specific external-source-available code.

**Open Questions:**
- Latest account halt, pending relay record, and health reason for the Ranger/Rebalancer accounts.
