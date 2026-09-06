# Frontend makeover — differential security review

Date: 2026-09-06. Baseline: `3df55c2b370daf5e2b4113428d1b21967b7e6a6f`.
Target: the frontend makeover and regression tests committed with this report.

## Executive summary

**Recommendation: approve this frontend change, subject to green CI and successful deployment checks.**
**Residual change risk: low.** No exploitable security regression was confirmed in the reviewed changes. This is not a full protocol audit or a guarantee of safe investments.

| Confirmed severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

The review covered all 39 changed/new frontend, browser-check and test files. Funding/account components received deeper review because presentation changes can obscure transaction state. No backend API, smart contract, dependency lockfile, wallet patch, permission scope, or deployment-secret configuration changed. Context records are in `audit-context/functions/makeover-funding-deposit.md` and `makeover-dashboard-recovery.md`.

## What changed

The baseline contains the September 6 exact-funding-allocation and session-refresh fixes. The makeover changes shared styling, navigation, discovery, profiles, setup, session presentation, and recovery placement. It also makes first-party search obey the entered term.

| Area | Change | Review priority |
| --- | --- | --- |
| `FundingDeposit.tsx` | Hide transfer instructions for saved funding; retain deductions, errors and net capital | High during triage; presentation-only authority |
| `ManagedWizard.tsx`, `StrategyWizard.tsx`, `SessionWizard.tsx` | Shared setup layout and progress; clearer copy | High during triage; no handler changes |
| Dashboard and position cards | Recovery disclosure, balance typography, status wording | High during triage; no withdrawal changes |
| `AgentCard.tsx`, profiles, claims | New summaries and identity presentation | Untrusted metadata / trust-label review |
| `directory-query.ts`, directory | Bounded literal first-party search | Medium |
| Layout, stylesheet, navigation, remaining pages/panels | Visual system and accessible controls | Low |
| `ui-review.mjs`, tests | Local browser review and regression assertions | Local tooling / coverage |

New navigation links are fixed internal paths. No new wallet dependency, external script, raw-HTML rendering, remote asset loader, or configurable redirect was introduced.

## Critical findings and adversarial checks

No blocking finding was confirmed. The following concrete scenarios were checked:

1. **Second deposit after a pending transaction.** `FundingDeposit.tsx:111` suppresses the transfer box when preparation status exists. Both production callers supply plan and status from the same checkpoint and lock selection (`ManagedWizard.tsx:1347`, `StrategyWizard.tsx:824`). The component cannot submit a transaction. A saved pending state remains pending; only confirmed state displays the receipt link. Rendering tests exercise both cases.
2. **Misleading capital after the deposit has been spent.** Saved plan values continue to override live balances at `FundingDeposit.tsx:44–51`. Exact bigint formatting and the majority-allocation warning remain outside the expandable fee explanation. Tests retain the historical BTCB amounts and exercise zero live balance with an existing funding plan.
3. **Signing or withdrawal triggered by opening recovery.** The two recovery components remain mounted behind the existing dashboard-loaded condition. Native disclosure opening has no signing handler (`dashboard/page.tsx:153–161`). Existing explicit submit handlers and destination/session-revocation checks remain unchanged.
4. **Registry metadata injecting HTML or impersonating verified status.** Card name/description are React text children (`AgentCard.tsx:48–66`); owner provenance remains visible. A new SSR regression renders script/image payloads and a first-party name on an unrelated claimed token: payloads are escaped and the first-party verification badge is absent. Verification still comes from the existing pinned identity/proof mapping, not the new summary or a name match.
5. **Search becoming an executable pattern or redirect.** `matchesDirectorySearch` (`directory-query.ts:105`) reuses the existing 80-character normalization and performs a literal string match. It does not compile user regular expressions, generate HTML, alter wallet state, or select an external URL. Existing URLSearchParams encoding remains unchanged.

## Test coverage

- `pnpm test`: **1,029 passing tests**, including **394 web tests**. Security additions verify escaped hostile metadata and full saved-funding presentation states.
- `pnpm --filter @agripinaa/web lint`: passed.
- `pnpm --filter @agripinaa/web typecheck`: passed.
- Production build and patched-wallet bundle check: passed for the makeover before this review; review changes only add tests and audit artifacts. CI repeats the production build before merge.
- Local production browser review: 20 views (10 routes at desktop/mobile widths), checking overflow, headings, skip destination, mobile navigation, first-party search, funding progress and recovery disclosure. No live wallet signature or deposit was performed.
- A TypeScript-AST comparison against the baseline found identical non-render statements in ten sensitive components/functions: ManagedWizard, StrategyWizard, ManagedPositionCard, StrategyPositionCard, SessionWizard, ClaimForm, X402Demo, DashboardPage, LostRangerRecovery, MissingActivationRecovery. Only JSX return trees and the presentation-only `primaryBtn` declaration were excluded from that comparison; their diffs were reviewed manually.

Coverage percentages were not instrumented. Tests establish the reviewed rendering and control-flow invariants, not every possible browser state or production transaction outcome.

## Blast radius

| Changed entry | Direct production call sites | Impact |
| --- | ---: | --- |
| FundingDeposit | 2 | Shared yield and non-yield funding presentation |
| SetupSteps | 2 | Both managed setup flows; no state mutation |
| MissingActivationRecovery | 1 | Explicit recovery navigation retained |
| LostRangerRecovery | 1 | Explicit recovery controls retained |
| AgentCard | 4 | Homepage, category, two directory sections |
| matchesDirectorySearch | 1 | First-party directory results only |
| SiteNav | 1 root layout | All pages; fixed internal links only |

Shared CSS has site-wide visual impact. Browser checks complement the source review; they do not replace the unchanged authorization boundaries.

## Historical context

- `3df55c2` introduced exact base-unit funding displays and the majority-allocation warning. Both survive this change; the original BTCB regression test is retained and extended.
- `2c7d018` introduced the shared deposit presentation. Its fixed zero sponsorship row is replaced by an explicit visible statement that fees and gas are paid from the deposit, not by Agripinaa. The real deductions remain visible.
- `b1635b2` introduced saved funding notices/receipt links. Their pending-versus-confirmed distinction is retained.
- `d43d5e16` and `59baa312` introduced recovery components now placed in the disclosure. They are not removed or conditionally unmounted on collapse.
- No removed authentication, destination validation, slippage enforcement, journal persistence, or pending-transaction guard was found in the diff. The recent wallet/provider patches are untouched.

## Recommendations and deployment boundary

### CI portability follow-up

Before merge, GitHub CI exposed a pre-existing failure also present on baseline run `34035162769`: `packages/agent-index/tests/scan8004.test.ts` was cancelled because its pending fetch mock had no referenced event-loop handle while `AbortSignal.timeout` uses an unreferenced timer. The test now keeps a referenced interval for the simulated socket lifetime and always clears it in `finally`. The request deadline, test timeout and rejection assertion are retained; no production timeout or indexer code changes. This additional test-only diff was reviewed separately from the 39 frontend files above.

No confirmed security finding requires a code fix before merge. Keep the added regression tests and existing patched-wallet build check. Merge only after CI succeeds, then verify the production alias and the new homepage/dashboard output.

Deploy the web application only. Do not rotate keys, change the runner, modify contracts, clear funding journals, sign transactions, or request another deposit as part of this release.

## Methodology and limitations

Used the differential-review workflow: change triage, baseline/history comparison, all changed-hunk review, direct-caller counts, a separate targeted audit-context trace, adversarial rendering tests, and regression checks. Analysis was focused on the 122-file frontend and the changed release surface, with deeper dependency tracing for funding and recovery.

Confidence is high that this diff preserves the examined authority and persistence handlers; it is not a fresh audit of unchanged backend/SDK/contract code, supply-chain advisories, provider solvency, or all chain/RPC behavior. Session data is still browser-local, provider availability still matters, and successful fresh passkey funding/withdrawal was not exercised with real funds during this review. Historical dossier questions outside the dated makeover addendum are not findings from this release review.
