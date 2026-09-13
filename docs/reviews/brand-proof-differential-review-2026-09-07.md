# Brand and Proof release review — 2026-09-07

## Executive summary

Recommendation: approve the reviewed release after green PR CI and production smoke checks. No new confirmed blocking security finding. This is a focused differential review, not a full-system security certification.

| New unresolved findings | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- |
| Reviewed release | 0 | 0 | 0 | 0 |

## What changed

Baseline: `9b1d376` (PR #21). Release scope: the accumulated, user-approved frontend design, bundled official brand assets and eight decorative strategy PNGs, animated header/footer marks, accessible Proof token logos, and shared surplus arithmetic/display changes. No dependency, workflow, transaction construction, session permission, contract, secret, or runner-service configuration changed.

| Area | Risk | Review focus |
| --- | --- | --- |
| Shared surplus and receipt arithmetic | Medium | Signed-fee basis, partial-fill denominator, malformed amounts, negative values, precision |
| Proof normalization and merge | Medium | Runner trust boundary, source precedence, unavailable data |
| Directory search and cards | Low | Owner-controlled text escaping, bounds, pinned first-party identity |
| Layout, images, CSS and navigation | Low | Local paths, passive SVG embedding, reduced motion, keyboard controls, mobile overflow |
| Asset generation and browser scripts | Low | Local-only output and browser targets, no account operations |

## Findings and invariants

- `packages/exec-metrics/src/surplus.ts`: missing/malformed values no longer silently become zero. Input strings are bounded before bigint arithmetic. Partial-fill BPS uses cross-products instead of a prematurely rounded token-unit limit. Separately signed fees are excluded consistently; embedded execution fees are not subtracted twice.
- `packages/exec-metrics/src/receipt/build.ts`: receipt ratios reuse the same arithmetic. Authentic Ophis appData/UID checks and trade/order association remain intact.
- `apps/web/src/lib/proof.ts`: runner-reported BPS is discarded. Only independently fetched order amounts produce BPS; a runner record cannot overwrite the recomputed value. Existing SSRF protection, response-size/time limits, pinned identities and receipt identifier validation remain.
- `apps/web/src/components/AgentCard.tsx`: owner strings remain escaped by React. The first-party visual identity uses the pinned registry, not a name claim. Both `min-w-0` and heading truncation remain, preserving PR #21's overflow fix.
- New artwork and protocol paths derive from committed slugs/maps. SVG files are embedded as images, never injected HTML; asset tests reject scripts, handlers, foreign objects and external references.
- Brand animation has cleanup, visibility-aware scheduling, a real static reduced-motion fallback, and keyboard-operable pause. Home links do not contain nested buttons. Decorative images do not represent balances or returns.

Concrete adverse cases checked: malicious owner HTML and very long names; malformed/negative/oversized execution amounts; signed fees producing a false loss; fractional fills whose rounded denominator becomes zero; stale runner BPS replacing current calculations; executable SVG payloads; and small screens causing action/label overflow. Regression tests cover these boundaries.

## Test coverage

Before this release: production build and wallet bundle guard passed; 402 web tests, 32 metric tests and 14 runner Proof tests passed; 44 local production browser views across 1440/768/390/320px passed. All five eye expressions, pause/reduced motion, card bounds, search, navigation, activation progress, asset loading and social image response were checked.

Release gate: reran the complete workspace test suite, `pnpm typecheck:ci` and web lint successfully. PR CI repeats workspace tests, type checks and the production build on Node 22. Vercel uses the project's existing Node 24 setting.

All 23 trade BPS values in the sampled live feed independently matched integer calculations from the source orderbook amounts at two display decimals. Examples: +130.98 and +123.45 bps. This verifies arithmetic against API data, not an independent replay of settlement contracts. Code coverage percentages were not instrumented; full signed-wallet activation was not exercised.

## Blast radius

`surplusBps`: five production calls, including its receipt-ratio adapter, aggregation, runner Proof, web Proof and execution summaries. `calcSurplusRaw`: one production caller in aggregation. `surplusRatio`: one receipt caller. `signedBps`: six display call sites across Proof, execution quality, track record and leaderboard. These changes affect reported metrics, not order submission or transfers. No high-blast-radius authorization function changed.

## Historical context

Blame traces the replaced surplus math to `55275a2c` and bigint compatibility fixes to `2e4c671b`; the divide-by-zero guard is strengthened, not removed. Proof receipt requirements from `91f439bb`, the SSRF routing introduced by `29fb9e0`, and authenticity checks retained through `e5b080e` remain. Directory fixes merged in `9b1d376` are preserved and regression-tested.

## Recommendations and deployment boundary

Merge only after CI succeeds; deploy the exact merged commit to the existing Agripinaa Vercel project and verify production HTML, assets and Proof JSON. Keep the previous Ready production deployment available for rollback: `agripinaa-2mo4bfpww-clementfrmds-projects.vercel.app`.

No VM restart is necessary for this frontend release: the web deployment contains the shared metric fix and deliberately ignores potentially older runner-reported BPS. Existing autonomous services and account state remain untouched.

Brand provenance and the previously disclosed Bloub design-rights limitation remain documented in `apps/web/public/brand/SOURCES.md`; this technical review does not establish trademark permission.

## Method and limitations

Differential-review skill: baseline/diff inspection, git history/blame, one-hop caller tracing, adversarial input checks, regression and browser evidence. Familiar baseline context from the prior makeover reviews was reused. Asset bodies were checked mechanically for executable/external content; visual review is not a licensing opinion. No independent dependency audit, contract audit, economic-strategy review or live fund-moving test was performed. Confidence is high for the tested changed paths, not a guarantee that the entire application has no bugs.
