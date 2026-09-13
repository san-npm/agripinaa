# Reviews and audits

Everything in this directory is a point-in-time record. Each file names the
commit it was run against; the code has moved since, and the table below says
where each finding stands today.

## ETHOnline 2026 audit, 2026-09-13

Run on `main` after the event work merged, before submission. Seven streams,
all read-only, findings fixed in the same night (PR "audit cleanup").

| Stream | Tool | Result | What changed |
|---|---|---|---|
| Static analysis | Semgrep, important-only, 11 rulesets (p/security-audit, trailofbits, Decurity smart contracts, p/secrets, elttam, apiiro, p/javascript, p/nodejs, p/react, p/typescript, p/github-actions) over 364 files | 4 findings: three unpinned GitHub Action tags, one loopback HTTP call in a local review script | CI actions pinned to commit SHAs. The loopback call is a DevTools endpoint on 127.0.0.1 and stays. |
| Differential security review | Trail of Bits differential-review skill over `5d8d9b9..main` (22 commits) | No critical, no high. 2 medium, 4 low. | Graph veto now has a plausibility bound against the chain's own rate (`plausibleAgainstChain`); the mint proof event carries its venue's position manager; `SIGNING_CHAINS` enforced on the AgentKit payload; the first API page is cut to the requested limit; admission has an 8 s deadline. |
| Sharp edges | Trail of Bits sharp-edges analyzer on the new surfaces | 4 medium, 8 low | Ranger's venue is selected by an explicit `managedAccount` flag set by the managed runner, not by signer type; a misnamed `LP_RANGE_VENUE` stops Ranger alone with a logged `config-error` instead of the whole runner; the plausibility bound and the admission deadline above. Accepted: a flood of fresh signatures can fill the nonce store and deny the free path for ten minutes; the paid path is unaffected. |
| Solidity | Trail of Bits solidity-auditor on `AgripinaaYieldRouter`, 12 specialist passes, 4 on scratch BSC forks | No critical, high or medium. Two low. | **Open, contract is deployed and immutable:** (1) a donated 1-wei receipt token in the other venue couples a rotation to that venue's pause state, so a paused Venus can block `toIdle()` for a user who is 100% in Aave; (2) sub-share dust makes a same-target rotation revert (`InvalidAmount`, `ZeroVenusMint`) instead of no-op, costing the agent retries. Both are availability, not value extraction; both clear on any real cross-venue move. Candidates for a v4 router. |
| Code quality | Ponytail audit of the event diff | 13 simplifications | One pool ABI for both venues (the uint8/uint32 split was unnecessary; ABI words are padded); `ctx.venue` instead of a WeakMap side channel; one `graphQuery` helper in `packages/shared`; one lane loop in the merged source; dead error classes, unused fields and a needless file-read cache removed. About 100 lines fewer. |
| Prior findings | Every item in the Pashov AI audit and in the reviews below re-verified against current code | All seven Pashov findings fixed; every review item fixed or accepted by design | One post-review design change is recorded here rather than in the old reviews: relay status `300` is now treated as failed (`eefa96d`, `b1fe9fc`, 2026-09-05), based on one observed call. If the relay ever answers a non-terminal 3xx, a duplicate manager grant becomes possible. |
| Readability | Repository inventory | 23 process artifacts at the visitor's eye level | Reviews moved here, investigations and superseded plans to `docs/archive/`, README links fixed. |

Not run: Pashov's own service was not re-engaged; the 2026-08-26 report is
below and its findings were re-verified line by line.

## Files

| File | Scope | Baseline |
|---|---|---|
| [`pashov-ai-audit-2026-08-26.md`](pashov-ai-audit-2026-08-26.md) | `AgripinaaYieldRouter` v1, seven findings, all fixed in v3 | 2026-08-26 |
| [`security-review-2026-09-03.md`](security-review-2026-09-03.md) | Recovery path for managed sessions | `17d4c70` plus the recovery patch |
| [`relay-pending-differential-review-2026-08-29.md`](relay-pending-differential-review-2026-08-29.md) | Relay-pending session grants | 2026-08-29 |
| [`steward-reset-differential-review-2026-08-31.md`](steward-reset-differential-review-2026-08-31.md) | Steward manager-key reset | 2026-08-31 |
| [`frontend-makeover-differential-review-2026-09-06.md`](frontend-makeover-differential-review-2026-09-06.md) | Frontend makeover, funding UX | 2026-09-06 |
| [`frontend-review-variants-2026-09-06.md`](frontend-review-variants-2026-09-06.md) | Variant analysis of the above | 2026-09-06 |
| [`brand-proof-differential-review-2026-09-07.md`](brand-proof-differential-review-2026-09-07.md) | Brand assets and proof metrics | 2026-09-07 |
| [`leaderboard-differential-review-2026-09-07.md`](leaderboard-differential-review-2026-09-07.md) | Leaderboard attribution | 2026-09-07 |
| [`proof-completeness-review-2026-09-07.md`](proof-completeness-review-2026-09-07.md) | Proof-scan completeness flag | 2026-09-07 |
