# Leaderboard correction — differential review

## Executive summary

Baseline: `1bb2b55ba0aa641b2ec13a9d2d6c3c3317a65312`; local working-tree changes, 2026-09-07.
Strategy: surgical review of a 378-file workspace, covering all 10 changed implementation/test files.
Risk: HIGH review priority because the change introduces cryptographic attribution and external reads; no transaction execution or permissions changed.
Recommendation: APPROVE for the explicitly bounded, API-based performance sample, not an independently indexed lifetime-performance service.

| Unresolved severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

This is a scoped engineering review, not a certification or independent external audit. Source-completeness and trust limitations below remain material.

## What changed

| Files | Change | Review priority |
|---|---|---|
| `packages/exec-metrics/src/cow.ts` | Verify the installed Altana/Porto ERC-1271 signature against a pinned manager; retain UID/appData verification | High |
| `apps/web/src/lib/exec.ts` | Shared own-wallet order fetch, owner binding, five-second timeout | High |
| `apps/web/src/lib/leaderboard.ts` | Swap-only rankings, bounded manager-signed candidates, deduplication, incomplete-history states | High |
| `apps/web/src/lib/strategy-activity.ts` | Receipt hash/status/sender checks; separate unattributed runner reports | High |
| `apps/web/src/lib/proof.ts` | Distinguish unavailable runner data from an available empty feed | Medium |
| `apps/agents/src/proof.ts` | Surface receipt-bearing managed lending reports without claiming verified attribution | Medium |
| Leaderboard page and TrackRecordPanel | Separate activity from swap scoring; truthful date and empty-state labels | Low |
| Web leaderboard tests and runner proof tests | SDK compatibility and adversarial regression cases | Medium |

## Critical findings and adversarial checks

No unresolved high/critical issue identified in this diff.

- **Forged runner agent label:** a compromised public feed can point at another agent's order UID. `readLeaderboardRecord` ignores the claimed agent when attributing swaps, reads the exact UID, and requires `isManagerSignedOrder` to recover a pinned manager. An unrelated user cannot obtain credit by changing the feed label or signing an Ophis-labelled order with their own key.
- **Signature/owner/order substitution:** `cow.ts:271` retains the canonical BSC UID and full appData hash checks, binds the nested ERC-1271 digest to the account, rejects unsupported signature formats/prehash flags, and checks the appended key hash against the recovered signer. Tested against the actual installed SDK's `signOrder`, not merely a duplicate test implementation.
- **Double counting:** lowercase order UID maps/sets deduplicate own-wallet and feed references. Managed fills are credited only once, after verification.
- **Receipt substitution or failed transaction:** `strategy-activity.ts:30` checks the requested hash and success status. The own-wallet label additionally requires the pinned sender. A relayed transaction does NOT independently prove the manager signer; it remains a runner-reported association and never earns a swap score.
- **Feed amplification/outage:** maximum 40 feed references; one shared read per UID per board; three-second order/receipt reads, five-second own-wallet/feed reads; up to five activity references per lending/protection agent. Committed references precede untrusted feed references so the latter cannot displace the known evidence. Errors are not displayed as zero activity.

## Test coverage

Runnable checks: `pnpm test`, `pnpm typecheck:ci`, `pnpm --filter @agripinaa/web lint`, and `pnpm --filter @agripinaa/web build`.

Targeted suites passed: web 405, runner 472, metrics 32. Tests cover valid SDK signatures, wrong manager, modified owner/amount, wrong key hash, prehash and scheme, duplicate orders, wrong returned UID, missing surplus, unavailable order reads, successful/reverted/mismatched receipts, and runner-managed pending/failure exclusion.

Local production browser checks passed at 1440px and 390px: four swap rows; four lending/protection cards with successful transaction links; no global horizontal overflow, render exception, or misleading “unranked” label. Original three numeric swap rows retain 15/4/4 fills and 120.9/22.9/20.4 scores. Browser checks are temporary diagnostics in `/private/tmp/agripinaa-performance-browser.mjs`.

No line-coverage percentage is claimed. Remaining coverage limits: no new real-money managed swap was submitted; no live runner was restarted; production deployment is not part of this turn. SDK compatibility was checked offline with a public synthetic test key.

## Blast radius

- `isManagerSignedOrder`: one production caller (`readLeaderboardRecord`), used by one leaderboard route.
- `getWalletOphisOrders`: two production callers (execution summary and leaderboard callback). Existing execution summary consumers are the orders API, execution-quality panel, and track-record reader; all retain own-wallet scope.
- `getRunnerEvidence`: three production consumers (existing events wrapper, leaderboard, lending activity). Existing proof feed response semantics remain compatible.
- Runner `mapLogEntry`: one mapping caller, feeding the existing public proof endpoint; new branch is read-only and cannot trigger an agent action.
- Date-label correction also reaches the profile track-record panel so it does not retain the same misleading label.

## Historical context

`git blame` identifies `e5b080e` (security remediation) as the source of UID/appData checks. Those checks remain intact; the new manager verifier layers on top. Prior leaderboard changes include `529b312` (settlement-based ranking) and `a630e55` (failure isolation). Per-row failure isolation remains; no feedback score or runner-reported BPS enters the ranking.

## Recommendations and limitations

1. Release web and runner proof-reader changes together when deployment is authorized. The runner addition reads existing managed-lending log decisions; it does not rerun transactions. Old runners do not emit these new report rows.
2. Managed discovery is a bounded recent feed, not full account history. Current pinned manager keys only are supported. Missing or suppressed feed references can omit real activity; signatures prevent false attribution but cannot prove completeness or eliminate selection bias.
3. Own-wallet execution status/amounts remain sourced from the CoW API, as before. This change does not independently replay settlements against BNB Chain logs. Activity receipts use a public BSC RPC, not a consensus quorum.
4. A successful transaction does not establish profitability, a successful strategy, or a managed mandate's signer. The page deliberately distinguishes these claims.
5. For lifetime managed performance, build a durable, independently verifiable execution index as a separately scoped change. Do not silently expand this sample into a claimed lifetime total.

## Methodology and references

Reviewed changed source and direct callers, retained security checks against git history, inspected installed Altana `internal/erc1271.js`, Porto `Key.sign`/`wrapSignature`, and Ophis order submission's raw-signature wire body. Compared UI results with the live own-wallet order histories from the preceding verification. Differential-review skill informed the attack cases and the separation of verified signatures from runner-reported associations.

Confidence: high for tested signature-format compatibility, deduplication and display semantics; limited for complete managed-history coverage, intentionally not claimed.
