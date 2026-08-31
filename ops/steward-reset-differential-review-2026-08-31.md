# Steward reset differential review — 2026-08-31

## Decision

Approve after production deployment verification. The reset fails closed: a replacement Steward manager grant cannot be submitted until the retired grant is conclusively impossible to execute or has been revoked.

## Scope

- Baseline: `b2678a4`
- Steward manager-key rotation and browser recovery
- Relay submission persistence and serialization
- Server-side retired-grant conflict guard
- Runner wallet identity and deployment preflight
- Altana SDK custom nonce forwarding

## Security invariants

1. A pending retired grant and its replacement cannot both become usable.
2. Relay uncertainty is never interpreted as failure.
3. Cancellation requires independent BNB Chain proof that nonce lane 0 advanced beyond the retired intent nonce and that the retired key is not live.
4. Browser storage loss cannot bypass the server-side conflict guard.
5. Duplicate tabs cannot submit duplicate grants or cancellation calls.
6. Existing account funds are neither re-deposited nor moved by the reset.
7. The runner cannot boot with a wallet whose derived public identity differs from the registered pin.

## Adversarial review

- A pending relay response (`300`) remains blocking.
- A single RPC response cannot authorize replacement; chain reads use the configured independent quorum.
- A relay failure is accepted only for the exact pinned call identifier and final failed status.
- If the old grant lands during cancellation, nonce invalidation fails safely and recovery switches to revoking the now-live key.
- If cancellation lands first, lane 0 advances past the retired nonce, making the old signed intent permanently unusable.
- Browser checkpoint writes use reservations, exact compare-and-swap replacement, and a browser lock; the runner adds an authenticated lease.
- Expiry, revoked registration, registered-but-invalid state, proven nonce invalidation, or exact relay failure are the only server-side paths that clear the retired conflict.

## Findings resolved

- Pending unregistered session keys cannot be revoked through the account key-removal path; reset now invalidates the retired intent nonce from an independent nonce lane.
- Fresh and concurrent browsers recognize an already-invalidated retired nonce before restoring or retrying a cancellation.
- Browser nonce completion reads are pinned to one block and require two matching independent RPC responses.
- Grant and revocation relay identifiers are persisted before waiting for receipts.
- Fresh browsers recover the public pinned retired-grant policy instead of reopening registration.
- Stale in-memory and stored sessions are reconciled before a replacement submission.
- Stale runner bindings are pruned with exact compare-and-swap semantics.
- Deployment verifies every loaded wallet and excludes archived retired wallets.
- The Altana SDK patch forwards an explicit nonce through prepare and execute calls.

## Blast radius and coverage

The primary callers are the managed activation wizard, grant-lease API, manager-key endpoint, runner activation binding, and deployment script. Added tests cover nonce invalidation, final relay failure classification, retired conflict decisions, storage recovery, duplicate submission prevention, manager pin validation, SDK nonce forwarding, and wallet boot verification.

## Verification

- `pnpm typecheck`: pass
- `pnpm test`: pass (990 tests across the final focused and repository-wide runs)
- `pnpm build`: pass
- `pnpm --filter @agripinaa/agents exec tsx src/verify-wallets.ts`: pass
- `git diff --check`: pass
- `zsh -n ops/deploy-aleph.sh`: pass
- Patched Altana package applied cleanly in a pristine-package dry run.
- Pashov blocker review: clean after cross-device and browser-quorum fixes.

## Residual operational risk

The owner must make one passkey-authorized on-chain cancellation transaction. A relay or RPC outage leaves the workflow pending and retryable; it does not submit a replacement or endanger funds. External Codex CLI review was unavailable due its account usage window; repository tests, differential review, and the Pashov review are the release gates used here.
