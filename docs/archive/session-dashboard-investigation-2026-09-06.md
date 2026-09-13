# September 6: deposit reconciliation and stale session dashboard

## Confirmed outcome

Account: `0x3cf79da486a3b286864f52139da73ff32ba7b972`.
Read-only BSC receipts and runner logs confirm that Steward entered Aave at
11:20 UTC (13:20 Luxembourg), after the user's 13:16 screenshot.
Transaction: `0x30691ac6e0af45128344d421b2187561f009c68a3dbd5694df48327aa2f3f702`,
successful at block 120293480. The account sent 0.495819755668504936 USDT through
the pinned yield router to Aave and received its aUSDT receipt token. Subsequent
runner sweeps reconciled the receipt and reported ready. The production status
proxy independently returned registered=true, service=ready.

The funding transaction
`0x41524c5f0f2cc60307efd2b165921a8541db2b5f11694fe6481b383d186a8379`
consumed exactly this BTCB split, read from Transfer logs:

| Use | BTCB input |
| --- | ---: |
| BNB provisioning for registrations and retained operating reserve | 0.000017840405821843 |
| Disclosed activation relay reimbursement | 0.000001931761574756 |
| Strategy capital, exchanged for 0.495819755668504936 USDT | 0.000006203986310367 |
| Total | 0.000025976153706966 |

The provisioning allocation is **not all a spent fee**. It bought
0.001883989940288845 WBNB. The batch withdrew its fixed BNB requirement, leaving
0.000036929108182041 WBNB in the user's account. Later reads found
0.000436228551501193 native BNB after registration and execution. These are
separate from the strategy's USDT balance. No deposit or signed transaction was
replayed during this investigation. This does not establish any USD valuation of
the original BTCB deposit.

## Original bug

Medium severity, high confidence: `ManagedPositionCard` loaded balances, session
validity and runner status only once per mount/identity change:

```ts
const timer = window.setTimeout(() => {
  // readManagedPosition, isSessionKeyValid, readManagedRunnerStatus
}, 0);
```

An unavailable result before the runner's first five-minute sweep stayed on
screen after the runner recovered and funds entered Aave. A balance read failure
also silently retained old balances. The invariant is that a live dashboard must
refresh asynchronous execution and authority changes without a page reload.

## Variant search

Root searches excluded dependency trees. The exact `readManagedRunnerStatus`
search found the shared definition and this sole component caller. Expanding to
`isSessionKeyValid` in components found the same read-once effect in `SessionCard`
and transaction-time guards in `ManagedWizard` and withdrawal handlers. Expanding
to balance/status polling found `StrategyPositionCard`, which already refreshed
balances every 15 seconds. No zero-match pattern was treated as evidence.

| Candidate | Severity / confidence | Verdict |
| --- | --- | --- |
| SessionCard validity effect | Medium / high | Confirmed variant: stale valid/unknown state survives expiry or RPC recovery |
| StrategyPositionCard balance/status read | Informational / high | Not a read-once bug; already polled, now reuses the shared non-overlap scheduler |
| Wizard and withdrawal key checks | Informational / high | Not variants: fresh transaction-time guards, not live display subscriptions |

## Fix and regression guard

All three session cards use one cancellable, non-overlapping polling helper.
Reads refresh 15 seconds after the previous read settles; transient failures do
not terminate polling. In-flight results are ignored after effect cleanup.
Yield/session authority polling pauses during their own write actions so an old
read cannot overwrite a just-confirmed revocation. Yield balances no longer
silently present a failed refresh as current. A manual Refresh also reloads yield
history and APYs. The yield display separates the native BNB balance from USDT.

The shared funding screen no longer truncates BTCB amounts to six decimals. It
shows exact input allocations and warns when fees plus gas provisioning exceed
half the deposit. This changes disclosure, not signed fees or transaction policy.

CI guard: `pnpm --filter @agripinaa/web test` includes `tests/poll.test.ts`, which
executes slow-read/error/retry/cleanup cases and asserts all three live card
components remain wired to the shared polling path. The workspace suite passed
1,026 tests before adding the rendered disclosure regression. The additional
`funding-disclosure.test.ts` renders the real funding component with the user's
exact amounts and checks warning boundaries (392 web, 471 agents, 164 packages
in the final 1,027-test suite).

## Remaining rollout boundary

Shared activation, receipt handling and dashboard code serve all eight agents.
Only this account's first-funding direct sender is enabled in production; the
retained single-transaction journal and approved gas cap are unchanged. This run
proves Steward's live funding, mandate and Aave entry, not live execution of every
strategy or permission to expand the gas-funded sender to arbitrary accounts.
The small WBNB remainder is user-owned but not part of the yield dashboard's
native BNB withdrawal path; recovering it requires a separate owner-signed action.
