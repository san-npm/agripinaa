# Runner registration and public status functions

## Web `POST /api/managed/[agent]/manage` in `apps/web/src/app/api/managed/[agent]/manage/route.ts` (L24-L47)

**Purpose:** Same-origin, bounded proxy from browser activation/handoff to the live runner.

**Inputs & Assumptions:**
- Agent slug/path and request body: untrusted public HTTP input.
- Assumes the runner will perform semantic/on-chain validation; explicitly documented at `L9-L14`.

**Outputs & Effects:** Rejects unknown slugs and oversized/non-UTF8 bodies, otherwise forwards bytes with a 15-second timeout and 64-KiB response cap (`L24-L47`).

**Block-by-Block:**

```ts
// L28-L40
if (!agentBySlug(agent)) return 400;
body = await readLimitedRequestText(...);
```

- **What:** Bounds path and body before resolving/fetching the runner.
- **Why here:** Prevents arbitrary path forwarding and unbounded serverless buffering.
- **Assumes:** Any first-party slug may be handed to the runner; managed capability is checked there.
- **Establishes:** Forwarded body is bounded text.
- **Depended on by:** `proxyToRunner`.

```ts
// L41-L47
return proxyToRunner(`/${agent}/manage`, { method: 'POST', body, timeoutMs: 15_000, ... });
```

- **What:** Echoes the runner response back to the browser.
- **Why here:** Browser never consumes tunnel URL/CORS directly.
- **Assumes:** Body serialization remains byte-exact through Fetch.
- **Establishes:** No semantic registration guarantee at the web tier.
- **Depended on by:** `registerManaged` interprets `res.ok && body.ok` (`apps/web/src/lib/managed.ts:L277-L293`).

**Cross-Function Dependencies:**
- `agentBySlug` (shared own-key lookup).
- `proxyToRunner` (web-to-runner external boundary).

**Open Questions:**
- Production response for each affected saved session; browser-local `registered` cannot prove current disk membership.

---

## `validateManageRequest` in `apps/agents/src/x402-server.ts` (L294-L380)

**Purpose:** Accepts only a live, exact canonical managed mandate that this runner can service.

**Inputs & Assumptions:**
- Deserialized public request body: untrusted.
- `managerSet`: trusted boot-time key material/public identities.
- Attestation client: runner's external BSC quorum client for yield routers.

**Outputs & Effects:** Returns a human-readable problem or null. It reads chain state but does not itself persist.

**Block-by-Block:**

```ts
// L307-L321
validate account, chain, walletAddress, publicKey, expiry, nonempty calls;
canonical = canonicalPermissionsFor(agent, chainId, first target);
```

- **What:** Anchors the request to one shared policy definition.
- **Why here:** Later comparisons have a canonical target/call/spend list.
- **Assumes:** First target is canonical; the exact call-order loop below establishes the rest (`L325-L335`).
- **Establishes:** No wildcard/unknown strategy enters this path.
- **Depended on by:** Runtime attestation and exact permission checks.

```ts
// L322-L361
attest router runtime; compare exact calls; bind token manager; compare spend caps;
```

- **What:** Ensures client bytes describe precisely the public policy.
- **Why here:** Prevents storing unusable/expanded client permission objects.
- **Assumes:** `canonicalStrategyPermissions` covers all account-local permissions expected from activation (`x402-server.ts:L137-L176`).
- **Establishes:** Expected manager identity and exact permission structure.
- **Depended on by:** Chain descriptor comparison.

```ts
// L364-L379
live = await isSessionKeyValid(...);
descriptor = await isAccountSessionDescriptorValid(...);
```

- **What:** Proves KeyStore liveness and exact smart-account identity/expiry/permission maps.
- **Why here:** A public key visible on-chain alone does not prove the submitted local descriptor.
- **Assumes:** RPC quorum and contract ABIs are authoritative.
- **Establishes:** Null return means the runner observed a currently executable canonical authorization.
- **Depended on by:** `/manage` constructs and persists a canonical session (`x402-server.ts:L1003-L1026`).

**Cross-Function Dependencies:**
- `canonicalPermissionsFor` selects shared non-yield or debt-complete yield policy (`x402-server.ts:L179-L194`).
- `isSessionKeyValid` and `isAccountSessionDescriptorValid` read external chain state (`packages/session-kit/src/verify.ts:L343-L356`, `L439-L515`).
- `isDebtCompleteRouterRuntime` verifies manifest code/version for yield routers (`packages/shared/src/contracts.ts:L63-L87`).

**Open Questions:**
- Whether production runner version and shared policy version match the browser version that created the saved records.

---

## Runner `GET /:agent/managed-status` handler in `apps/agents/src/x402-server.ts` (L889-L952)

**Purpose:** Exposes non-secret registration, liveness, halt, and Ranger position identity to the owner dashboard.

**Inputs & Assumptions:**
- Agent/path, account, target/router query: untrusted public HTTP.
- Durable registry and agent state: locally trusted but disk-derived.
- Assumes `loadManaged` contents have the canonical layout established at admission. On-read revalidation: **nothing found** (`apps/agents/src/managed.ts:L80-L89`).

**Outputs & Effects:** JSON `{registered, service, reason, lastSweepAt, positionTokenId}` with no-store caching (`L942-L951`). Read-only.

**Block-by-Block:**

```ts
// L914-L925
registeredEntry = loadManaged(agent).find(account + first target);
halted = managedServiceHalt(...);
health = state.get(managedHealthKey(...));
```

- **What:** Joins registry membership, halt state, and sweep health.
- **Why here:** None of those facts alone means the worker is currently operating.
- **Assumes:** The first call is the identity target; current admission establishes order.
- **Establishes:** Health is read only for a registered entry.
- **Depended on by:** Ready/status selection.

```ts
// L926-L951
fresh = health age <= 20 minutes;
ready = registered && fresh && health.result === 'ready';
service = !registered ? not-registered : halted ? halted : ready ? ready : unavailable;
```

- **What:** Produces the service state and retained Ranger NFT ID.
- **Why here:** Stale positive state must age out; position ownership survives authority.
- **Assumes:** Wall-clock comparability between health write and request in one process/host.
- **Establishes:** `ready` requires disk membership and recent successful health.
- **Depended on by:** Browser `runnerCopy`/`managedServiceStatus`.

**Cross-Function Dependencies:**
- `loadManaged`, `managedHealthKey`, `managedAccountStateKey`, `managedRangerTokenId` from `managed.ts`.
- `managedServiceHalt` distinguishes account/global halt (`x402-server.ts:L111-L125`).

**Open Questions:**
- Exact production response/reason/lastSweepAt for the screenshot tuples.

---

## `proxyToRunner` in `apps/web/src/lib/proxy-runner.ts` (L59-L70)

**Purpose:** Converts the rotating-tunnel external call into a bounded same-origin response.

**Inputs & Assumptions:**
- A path built by a route handler and safe-fetch options.
- Assumes caller validates path intent; this module explicitly does not (`proxy-runner.ts:L37-L39`, `L56-L57`).

**Outputs & Effects:** Preserves upstream bytes/status with JSON/nosniff headers, or returns a generic 502 (`L59-L70`).

**Cross-Function Dependencies:**
- `agentsUrl`/runner-base selection, then shared SSRF-safe bounded fetch (`proxy-runner.ts:L25-L45`; `runner-url.ts:L49-L63`).
- The managed status browser parser maps non-OK 502 to unavailable (`apps/web/src/lib/managed-router.ts:L20-L40`).

**Open Questions:**
- Which runner base source wins in production and whether it points at a live tunnel.
