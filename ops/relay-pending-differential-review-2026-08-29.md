# Relay-pending activation differential review

Date: 2026-08-29  
Baseline: `b1635b2` (`fix: clarify activation confirmation flow`)  
Scope: five modified web files; 379 tracked repository files  
Review strategy: surgical, high-risk focus on external relay calls and irreversible session grants

## Executive summary

Final verdict: **APPROVE**. No open critical, high, medium, or low findings remain.

The change replaces the blocking pending-grant error with a persistent, accessible relay-status state. It polls the saved call ID without entering the SDK's four-minute wait, preserves the no-duplicate-grant invariant while the outcome is unknown, verifies successful receipts before accepting a grant, and enables a fresh grant only after a terminal failure.

## Security invariants reviewed

- Funding confirmation never authorizes a duplicate funding transaction.
- An unknown or pending relay outcome never authorizes a duplicate manager grant.
- A relay response must match the exact saved 32-byte call ID.
- A grant is accepted only with top-level confirmation, a valid transaction hash, and a non-reverted receipt.
- A terminally failed or reverted grant cannot be rediscovered as usable through relay history.
- The browser checkpoint is retained for pending/confirmed recovery and cleared only after terminal failure or durable session storage.
- The runner receives a session only after receipt reconciliation and existing on-chain session validation.

## Remediated review findings

1. **P2 — failed relay required two retry clicks.** The first intentional retry now clears the failed checkpoint and proceeds through the fresh-grant checks in the same click.
2. **P1 — reverted receipt classified as confirmed.** Receipt status `0x0` is now terminal failure; confirmation without a valid receipt transaction hash remains pending.
3. **P2 — successful grant left stale pending UI state.** Relay state is cleared immediately after final receipt reconciliation so Ophis authorization and runner-handoff labels are not masked.
4. **P1 — SDK/history status could bypass receipt failure.** Newly returned SDK sessions and relay-history matches are rechecked through the same receipt-aware parser before storage or reuse.

## Blast radius

- `parseRelayCallStatus`: one production caller (`readRelayCallStatus`) plus direct tests.
- `readRelayCallStatus`: background notice polling, two checkpoint recovery paths, two post-submission paths, and relay-history reconciliation.
- `RelayGrantNotice`: two callers, covering managed-yield and strategy activation wizards.
- User-visible impact: all eight first-party activation routes that resolve through those two wizards.

The prior duplicate-prevention and irreversible-grant recovery behavior originated in `c1f67ff` (`fix(web): recover irreversible agent grants`). Git history and blame were checked to ensure the patch changes presentation and terminal-state reconciliation without weakening those guards.

## Adversarial analysis

- A mismatched or malformed relay call ID is rejected instead of updating another grant's UI state.
- Relay timeouts and unreadable responses preserve the known pending checkpoint, preventing a duplicate submission.
- A forged top-level success with no valid transaction hash is not accepted as confirmation.
- A top-level success containing a reverted receipt is treated as failed and excluded from history recovery.
- A failed grant can be retried, but only after the existing on-chain/session and account-history checks run again.

Residual trust assumption: Altana's relay semantics remain an external dependency. Agripinaa follows the installed Altana SDK's vendor-specific handling of status `300` as unresolved and requires receipt evidence before success.

## Verification

- `node --import tsx --conditions=react-server --test --test-reporter=dot tests/*.test.ts` — 368/368 passed.
- `pnpm --filter @agripinaa/web typecheck` — passed.
- `pnpm --filter @agripinaa/web lint` — passed.
- `pnpm --filter @agripinaa/web build` — passed; all 63 pages generated.
- `git diff --check` — passed.
- Final `codex review --uncommitted` — no actionable regressions.

Coverage limitation: component state transitions are compiled, linted, and exercised through their shared parser tests, but the repository has no DOM-level wizard harness. Confidence is high for relay classification and duplicate prevention, and moderate-high for visual state sequencing.
