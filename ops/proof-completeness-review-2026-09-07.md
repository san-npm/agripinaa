# Proof scan completeness — focused variant review

## Summary

2026-09-07, Agripinaa, baseline `c569f67`. Confirmed the reported P1: an events array was treated as a complete runner scan despite omitted order lookups. No additional independent ranking bug confirmed in the bounded sibling search.

## Original issue

The invariant is that omitted, unresolved order candidates must not appear as a complete performance sample. In `apps/web/src/lib/proof.ts`, the original code was:

```ts
return { events: normalizeProofEvents(events), available: Array.isArray(events) };
```

Runner `enrichOphisTrades` returned `null` both for known unsettled orders and failed/deadline-skipped lookups. Only the first is a verified exclusion. The HTTP response and cache lost that distinction, so both leaderboard and lending-activity consumers could suppress their existing incomplete-history warnings.

## Search methodology

Root-wide ripgrep searches, followed by source/caller inspection:

| Pattern | Matches | Relevant | Ruled out |
|---|---:|---:|---:|
| `available: Array.isArray\(` | 1 | 1 | 0 |
| `catch\(\(\) => \[\]\)` | 4 | 1 | 3 |

The generalized catch pattern was 75% noise; stopped expanding it. Traced `getRunnerEvidence`, `collectProofEvents`, and `enrichOphisTrades` callers explicitly instead. No zero-match pattern was relied on.

## Findings and fix

- **P1, high confidence:** order lookup failures and deadline-skipped candidates silently produced an apparently complete sample. Runner now returns `{ events, complete }`; its cached `/proof` response preserves both. Web requires literal `complete: true`, treating legacy/malformed flags conservatively. Verified partial events are retained, and existing leaderboard/activity warning paths receive `available: false`.
- **P2, high confidence, same scan contract:** trade-detail failures or a deadline before fetching details were swallowed by `.catch(() => [])`. These do not omit the already fulfilled UID, but leave enrichment incomplete; the same flag now covers them without discarding the order.
- A normal output limit or verified open/cancelled order is not an upstream failure. Completeness remains scoped to the bounded sample, never lifetime history. No change to signing, settlement validation, execution, or session state.

## Ruled-out matches

Informational, high confidence: `withLiveness` removes an unverified live badge; `getReceipt` exposes a missing trade as null and does not assert a complete scan; `storedClaims` is an optional metadata fallback, not a performance completeness signal. These are not variants of this ranking bug. This is not a whole-repository security audit.

## Regression guard

Existing CI runs `pnpm test`. Runner regressions cover failed lookups, skipped deadlines, retained receipt events, failed/skipped trade details, successful/empty/unsettled/output-limited scans, and the public cached HTTP response. Web regressions cover partial and legacy responses, strict boolean validation, retained evidence, and malformed arrays. The original web implementation failed with `true !== false` before the fix.

Verification passed: 1,050 workspace tests, workspace typechecks, web lint, production build and wallet bundle guard. Built leaderboard HTML also retains all four managed-history warnings against the currently deployed legacy runner response, exercising propagation through the actual Next.js render. Not merged or deployed in this turn.

Optional CI-ready static guard (no new tooling dependency added):

```yaml
rules:
  - id: proof-array-is-not-completeness
    languages: [typescript]
    severity: ERROR
    message: Require explicit runner scan completeness, not just an events array.
    paths:
      include: [apps/web/src/lib/proof.ts]
    pattern: '{ ..., available: Array.isArray($EVENTS), ... }'
```

Release requires both runner and web changes. Deploying web first is conservative: an older runner lacks the flag and therefore shows an incomplete-history warning.
