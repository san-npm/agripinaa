# Frontend review variant analysis

## Summary

| Field | Value |
| --- | --- |
| Original bugs | Three P2 review comments: card-name overflow, summary search mismatch, contradictory empty state |
| Analysis date | 2026-09-06 |
| Baseline | `88c1d91204557c2a33f1f7a1ab725f1b2ef41f91` |
| Scope | Shared directory cards, first-party search, independent-listing status messages |
| Additional variants | One confirmed wording variant: independent search failure described all search as unavailable |

## Root causes and fixes

1. `AgentCard` rendered owner-controlled names without overflow containment. Restored native CSS truncation with `min-w-0`; a title preserves access to the full name. The production browser test exposed a second required constraint: the card itself needs `min-w-0` to shrink inside implicit mobile grid tracks. All four card render sites inherit both constraints.
2. `matchesDirectorySearch` omitted the first-party summary rendered by the card. It now includes the same `agentExperience` summary, resolved by pinned token ID, while retaining registry-description matching. A matching name alone does not grant first-party summary behavior.
3. `EmptyListing` described independent results as all agents. Its existing decision logic now lives in the testable `independentListingEmptyReason` helper, with every branch explicitly scoped to independent listings. The section heading is scoped too.
4. The adjacent `searchUnavailable` notice had the same scope error: local first-party filtering still works when upstream independent search fails. Its wording now identifies only independent-directory search as unavailable.

These are confirmed UX defects, not demonstrated fund-loss or code-execution vulnerabilities. The fixes do not change permissions, funding, registry verification, or runner execution.

## Search methodology

Used repository-wide `rg`, then inspected the relevant web source and callers:

| Pattern | Relevant matches | Triage |
| --- | --- | --- |
| Unbounded `AgentCard` name heading | 1 | Confirmed; fixed at the shared component |
| `<AgentCard` | 4 render sites | Homepage, category, both directory sections share that component |
| `matchesDirectorySearch` | 1 definition, 1 production caller | Confirmed missing display summary |
| `experience?.summary` | 3 display sites | Card, profile, activation reuse one summary source; no separate search implementation |
| Global empty-state wording and adjacent search-failure notice | Directory page | Confirmed scope mismatch; scoped all helper branches and the failure notice |

Profile and activation summary displays are not additional search defects: they contain no competing matcher. Static configured strategy names and broader non-card name layouts were not treated as demonstrated variants. This is a targeted follow-up, not a whole-application overflow or security audit.

## Regression checks

Final result: 396 web tests passed; lint, typecheck, production build, and all 22 browser views (11 routes at 1440px and 390px) passed. No merge or deployment was performed for this follow-up.

- `pnpm --filter @agripinaa/web test`: checks all configured first-party summaries, legacy registry wording, normalization, an unpinned lookalike name, all independent empty-state branches, and escaped/bounded owner metadata.
- `pnpm --filter @agripinaa/web lint` and `pnpm --filter @agripinaa/web typecheck`.
- `pnpm --filter @agripinaa/web build`: production compilation and the existing wallet bundle guard.
- `node apps/web/scripts/ui-review.mjs` against a local production preview and isolated Chrome: desktop/mobile summary search, noncontradictory search copy, and injected 2,000-character unbroken names in directory/category grids, alongside existing page checks.

Keep these checks in the existing test/review workflow. No new dependency or static-analysis rule is needed for these rendering and copy regressions.
