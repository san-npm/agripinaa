# Session authority and persistence functions

## `storeSession` in `apps/web/src/lib/session-store.ts` (L117-L167)

**Purpose:** Persists the browser's public recovery/revocation record without the manager private signer.

**Inputs & Assumptions:**
- `session`: returned by the external Altana SDK; semi-trusted.
- `chainId`, agent metadata, display scope/principal: application inputs.
- `stripSigner` removes the top-level signer before serialization (`apps/web/src/lib/session-store.ts:L103-L115`). Assumes no signer secret appears in another nested location: establishing recursive absence is **nothing found**.

**Outputs & Effects:** Writes one local record, deduplicated by live account/public-key/agent identity, initially `pending` unless an existing record is registered (`L124-L166`).

**Block-by-Block:**

```ts
// L124-L149
const raw = serializeSession(stripSigner(input.session));
const sameGrant = (...) => candidate.revokedAt === null && ... publicKey/account/agent match;
```

- **What:** Produces byte-stable public session text and finds a prior record of the same grant.
- **Why here:** Recovery of a handoff must not make duplicate cards for one irreversible registration.
- **Assumes:** `walletAddress` and `publicKey` identify the exact authority; malformed missing values do not deduplicate.
- **Establishes:** One active local card per exact grant under normal inputs.
- **Depended on by:** Revocation and finish-handoff use the saved raw bytes.

```ts
// L150-L166
const meta = { ..., revokedAt: null, registrationStatus: existing?.registrationStatus ?? 'pending', raw };
write([...sessions.filter(...), meta]);
```

- **What:** Preserves original grant time/registration marker and refreshes correlation/raw bytes.
- **Why here:** Separates on-chain grant completion from runner acknowledgment.
- **Assumes:** Browser storage write succeeds; caller compensates new-session storage failure during activation (`apps/web/src/components/StrategyWizard.tsx:L621-L655`).
- **Establishes:** Local `revokedAt` starts null, but does not establish live on-chain authority.
- **Depended on by:** Dashboard checkpoint correlation and cards.

**Cross-Function Dependencies:**
- `serializeSession` preserves bigint markers (`packages/session-kit/src/codec.ts:L7-L20`).
- `write` writes the complete array to localStorage (`apps/web/src/lib/session-store.ts:L60-L62`).
- Shared state: browser storage only.

**Open Questions:**
- Shape and age distribution of production local records.

---

## `isSessionKeyValid` and `quorumBooleanRead` in `packages/session-kit/src/verify.ts` (L278-L299, L328-L357)

**Purpose:** Establishes whether the exact saved public key currently has live KeyStore authority for the smart account.

**Inputs & Assumptions:**
- Account/public key from browser record or runner registry: semi-trusted.
- RPC responses: untrusted external sources.
- Fixed KeyStore addresses for chains 56 and 97 (`verify.ts:L19-L22`).
- Assumes the documented KeyStore v0 convention and ABI remain correct (`verify.ts:L1-L12`).

**Outputs & Effects:** Returns unanimous boolean from the configured RPC set, or throws on disagreement/insufficient quorum. No state writes.

**Block-by-Block:**

```ts
// L283-L299
const settled = await Promise.allSettled(urls.map(read));
if (values.length >= 2 && values.every(...)) return values[0];
throw new Error('authority RPC quorum unavailable or disagreed');
```

- **What:** Requires two equal default-provider results; a caller-supplied single RPC accepts one result.
- **Why here:** Avoids converting stale disagreement into a definitive stopped/live answer.
- **Assumes:** Default URLs are independent enough for agreement to be meaningful; independence check: **nothing found**.
- **Establishes:** Default-path false is not a lone-provider observation.
- **Depended on by:** UI badges, withdrawal stop proof, registration validation, and every worker sweep.

```ts
// L343-L356
return quorumBooleanRead(... isValidKey(account, keccak256(publicKey)));
```

- **What:** Reads live authority for exact account/key ID.
- **Why here:** Expiry/revocation are KeyStore state, not local timestamps.
- **Assumes:** SEC1 bytes are correct; `keccak256`/contract reject malformed hex by throwing.
- **Establishes:** `false` combines absent, expired, and revoked (`L338-L341`).
- **Depended on by:** All status and pruning paths described above.

**Cross-Function Dependencies:**
- `keyIdFromPublicKey` computes the KeyStore ID (`verify.ts:L254-L256`).
- Viem `readContract` and RPC transports are external black boxes.
- `isAccountSessionDescriptorValid` additionally proves exact account-local identity/expiry/permissions during runner admission (`verify.ts:L433-L515`).

**Open Questions:**
- The exact provider response set for the screenshot timestamp.
- Whether production uses an `rpcUrl` override, which reduces the read to one provider (`verify.ts:L267-L275`, `L288-L289`).

---

## `SessionCard.revoke` in `apps/web/src/components/SessionCard.tsx` (L60-L97)

**Purpose:** Ends a saved session with owner authentication.

**Inputs & Assumptions:**
- Saved account/raw session: browser-local, untrusted until owner/account and chain calls succeed.
- Passkey-recovered wallet: external SDK result.

**Outputs & Effects:** Sends a revocation transaction; on `CONFIRMED`, writes `revokedAt`, updates UI validity to invalid, refreshes dashboard, and emits a toast (`L64-L96`).

**Block-by-Block:**

```tsx
// L64-L78
const wallet = await client.recoverFromPasskey();
if (wallet.address !== meta.account) throw ...;
const session = reviveSession(meta);
await client.revokeSession(...);
```

- **What:** Reauthenticates and targets the saved public session.
- **Why here:** Only the smart-account owner/admin can revoke.
- **Assumes:** Deserialized `raw` matches the granted session; on-load validation: **nothing found**.
- **Establishes:** The recovered passkey controls the recorded account before submission.
- **Depended on by:** Confirmation/local mutation block.

```tsx
// L79-L89
if (result.status !== 'CONFIRMED') throw ...;
markRevoked(meta.id); setValidity('invalid');
```

- **What:** Refuses to treat pending/failed SDK results as stopped.
- **Why here:** Local state must not outrun irreversible chain state.
- **Assumes:** SDK `CONFIRMED` accurately describes execution; no independent receipt/KeyStore reread here: **nothing found**.
- **Establishes:** Local revoked marker follows confirmed result.
- **Depended on by:** UI and pending-checkpoint matching.

**Cross-Function Dependencies:**
- `altanaClient().recoverFromPasskey/revokeSession`: external black boxes.
- `reviveSession` is direct `deserializeSession(meta.raw)` (`apps/web/src/lib/session-store.ts:L185-L186`).
- Worker pruning does not happen synchronously; later sweeps call `isSessionKeyValid`.

**Open Questions:**
- The SDK result/receipt for each affected screenshot grant.
