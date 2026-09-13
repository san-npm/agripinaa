# Owner withdrawal and yield-router functions

## `ManagedPositionCard.ensureSessionStopped` in `apps/web/src/components/ManagedPositionCard.tsx` (L201-L222)

**Purpose:** Makes stopped manager authority a precondition for owner recovery.

**Inputs & Assumptions:**
- Passkey-recovered wallet already matched to `meta.account` by `reauth` (`ManagedPositionCard.tsx:L167-L174`).
- Saved public key/account/chain from browser-local state.

**Outputs & Effects:** Throws on unverifiable authority; revokes a live session; or locally records an already-invalid session (`L201-L222`).

**Block-by-Block:**

```tsx
// L203-L215
require key/account; live = await isSessionKeyValid(...); RPC failure => throw;
```

- **What:** Demands a definitive current chain result.
- **Why here:** Withdrawal must not race live automation.
- **Assumes:** KeyStore validity fully represents manager execution authority.
- **Establishes:** No owner unwind proceeds on authority uncertainty.
- **Depended on by:** Both stablecoin and BNB withdrawal functions.

```tsx
// L216-L221
if (live) await doRevoke(wallet); else markRevoked/set invalid;
```

- **What:** Ends authority if necessary and synchronizes local display.
- **Why here:** Avoids redundant revoke on monotonic invalid state.
- **Assumes:** `doRevoke`'s SDK `CONFIRMED` result is sufficient; independent post-revoke KeyStore reread: **nothing found** (`ManagedPositionCard.tsx:L180-L199`).
- **Establishes:** Caller returns only after confirmed revoke or prior definitive invalidity.
- **Depended on by:** Asset movement.

**Cross-Function Dependencies:**
- `isSessionKeyValid` (KeyStore quorum).
- `doRevoke` (external Altana owner transaction plus local mutation).

**Open Questions:**
- Whether affected withdrawal attempts reach this function and, if so, which branch/error occurs.

---

## `ManagedPositionCard.withdrawUsdtOut` in `apps/web/src/components/ManagedPositionCard.tsx` (L224-L269)

**Purpose:** Full or partial owner exit from a yield-router-managed stablecoin account to an external address.

**Inputs & Assumptions:**
- `dest`: user/browser input; untrusted.
- Saved scope router and account; untrusted until resolved against shared deployment lists.
- Current chain balances and external owner SDK/relay.

**Outputs & Effects:** Stops session, optionally unwinds debt-free venue legs, transfers exact idle balance, refreshes display, and reports partial/full result (`L226-L268`).

**Block-by-Block:**

```tsx
// L227-L236
require statically valid destination and recognized scoped router;
reauth owner; ensureSessionStopped;
```

- **What:** Establishes destination, account ownership, and no live manager before asset movement.
- **Why here:** Prevents agent redeployment during exit.
- **Assumes:** Later live bytecode check may still reject a statically valid destination.
- **Establishes:** Owner identity and stopped-key preconditions.
- **Depended on by:** Unwind/transfer.

```tsx
// L237-L246
read current position; if deployed and current debt-complete recovery exists, withdrawToIdle;
otherwise allow idle-only recovery or stop with no movement;
```

- **What:** Selects full unwind versus idle-only recovery.
- **Why here:** Retired/incomplete routers are not used for deployed automation.
- **Assumes:** `deployedWei` from receipt balances/underlying estimate represents withdrawable or debt-encumbered legs; router makes the final debt decision.
- **Establishes:** Automated deployed unwind targets only current v3.
- **Depended on by:** Fresh reread.

```tsx
// L247-L261
reread; require idle > 0; transfer fresh.idleWei; report partial if deployed remains;
```

- **What:** Avoids using pre-unwind amounts and transfers only available idle funds.
- **Why here:** Debt-bearing legs may remain after `toIdle` without reverting.
- **Assumes:** No balance change occurs between reread and owner transfer; if it does, the ERC-20 call/relay determines outcome.
- **Establishes:** Success toast follows a confirmed exact transfer (`apps/web/src/lib/managed.ts:L245-L262`).
- **Depended on by:** UI refresh.

**Cross-Function Dependencies:**
- `destinationProblem` (static), `ensureSessionStopped`, `readManagedPosition`, `withdrawToIdle`, `sendTokenOut`.
- External boundaries: BSC RPC, Altana owner recovery/execute, token and venue contracts.

**Open Questions:**
- Exact error surfaced for the screenshot attempt.
- Whether remaining deployed balance is debt-encumbered or an unwind/approval/relay failure.

---

## `assertSafeWithdrawalDestination` and `sendTokenOut` in `apps/web/src/lib/managed.ts` (L219-L262)

**Purpose:** Prevents full-balance owner transfers to disallowed destinations and confirms the resulting owner transaction.

**Inputs & Assumptions:**
- Destination and recovered wallet account: untrusted/application boundary.
- Multiple public RPC bytecode responses.

**Outputs & Effects:** Throws unless destination is statically acceptable and RPC quorum classifies it as no-code; then sends one exact ERC-20 transfer and requires `CONFIRMED` (`L219-L262`).

**Block-by-Block:**

```ts
// L219-L238
static destinationProblem; Promise.allSettled(getCode per RPC); destinationCodeQuorumProblem;
```

- **What:** Rejects invalid/same/system addresses and arbitrary deployed contracts.
- **Why here:** It runs immediately before the irreversible transfer.
- **Assumes:** EOA-only destinations are the product policy. A contract-wallet alternative is **nothing found**.
- **Establishes:** On mainnet, at least two provider results classify destination as no-code (`apps/web/src/lib/managed-pure.ts:L28-L39`).
- **Depended on by:** Token and native sends.

```ts
// L245-L262
require amount > 0; validate destination; execute ERC20 transfer; assertConfirmed;
```

- **What:** Sends exact amount from the recovered smart account.
- **Why here:** Unwind and outward transfer are separate owner executions.
- **Assumes:** Token contract at the manifest address implements standard transfer behavior.
- **Establishes:** Function success means SDK reported confirmed.
- **Depended on by:** `withdrawUsdtOut` success UI.

**Cross-Function Dependencies:**
- `destinationProblem` rejects malformed, zero/precompile, same-account, and known managed-system destinations (`apps/web/src/lib/managed-pure.ts:L6-L14`).
- `destinationCodeQuorumProblem` requires a classification quorum (`managed-pure.ts:L28-L39`).
- `assertConfirmed` distinguishes confirmed from pending/failed (`apps/web/src/lib/managed.ts:L64-L75`).

**Open Questions:**
- Whether `0x46A15...` was meant as a withdrawal destination or accidentally copied from the Ranger position link/config.

---

## `withdrawToIdle` in `apps/web/src/lib/managed.ts` (L186-L209)

**Purpose:** Owner-authorized atomic approval refresh plus unwind through the current debt-complete router.

**Inputs & Assumptions:**
- Recovered owner wallet, chain, managed token.
- Shared current deployment manifest and live runtime.

**Outputs & Effects:** Attests runtime, submits approval calls plus `toIdle()`, and requires a confirmed bundle (`L192-L209`).

**Block-by-Block:**

```ts
// L197-L201
router = routerFor(chainId, token);
require debt-complete metadata; assertRouterRuntime;
```

- **What:** Pins unwind to the current manifest and live code/version quorum.
- **Why here:** A saved retired router is only a read/recovery classifier, not the execution target.
- **Assumes:** Shared runtime hash/version identify the intended contract.
- **Establishes:** Submitted call target is the attested current deployment.
- **Depended on by:** Execution batch.

```ts
// L202-L208
execute([...routerApprovalCalls(router), managedUnwindCall(chainId, token)]);
assertConfirmed;
```

- **What:** Grants fresh exact-router approvals and unwinds atomically.
- **Why here:** A partial approval cannot be mistaken for completed recovery.
- **Assumes:** Owner wallet admin execution can authorize ERC-20 approvals and router call.
- **Establishes:** Function success follows confirmed atomic owner execution.
- **Depended on by:** Post-unwind balance reread.

**Cross-Function Dependencies:**
- `routerApprovalCalls` approves stablecoin/aToken/vToken to the current router (`managed.ts:L96-L105`).
- `managedUnwindCall` emits the fixed zero-arg `toIdle` selector (`apps/web/src/lib/managed-router.ts:L124-L135`).

**Open Questions:**
- Production runtime-quorum observations and relay result for the attempted withdrawal.

---

## `AgripinaaYieldRouter.toIdle` and `_collectUsdt` in `contracts/src/AgripinaaYieldRouter.sol` (L183-L244)

**Purpose:** Converts the caller's safe venue receipt legs into idle stablecoin while never selecting an arbitrary recipient.

**Inputs & Assumptions:**
- Implicit `msg.sender`: the user's smart account executing owner/session call.
- Fixed immutable token/venue dependencies bound by constructor checks (`AgripinaaYieldRouter.sol:L122-L148`).
- External Aave/Venus/token calls may revert or return error codes.

**Outputs & Effects:** Pulls debt-free caller receipts, redeems them, returns only the call-created stablecoin delta to caller, emits rotation/skip events, and retains no call-created funds (`L183-L244`).

**Block-by-Block:**

```solidity
// L183-L192
amount = _collectUsdt(msg.sender, IDLE);
if amount > 0 transfer(msg.sender, amount);
emit Rotated when amount > 0;
```

- **What:** Hardcodes the output recipient to caller.
- **Why here:** Session permissions cannot constrain call arguments, so there is no recipient argument.
- **Assumes:** Token returns a truthful boolean; false reverts.
- **Establishes:** Successful call returns collected value to the initiating account.
- **Depended on by:** Browser and manager zero-argument unwind calls.

```solidity
// L203-L220
snapshot router USDT; inspect caller vTokens; if any Venus debt emit skip, else transferFrom + redeem;
```

- **What:** Processes the Venus source leg only when no VAI/market debt is found.
- **Why here:** Receipt movement could affect debt-backed collateral.
- **Assumes:** Comptroller membership plus stored borrow balances and VAI ledger cover the intended debt predicate (`L253-L267`).
- **Establishes:** Encumbered Venus receipts stay with caller.
- **Depended on by:** Delta result.

```solidity
// L222-L234
inspect caller aTokens; if aggregate Aave debt emit skip, else transferFrom exact balance + withdraw exact amount;
```

- **What:** Processes debt-free Aave receipts and requires exact withdraw result.
- **Why here:** Pre-existing router receipts are excluded; caller amount is exact.
- **Assumes:** `getUserAccountData.totalDebtBase` covers relevant Aave debt.
- **Establishes:** Encumbered Aave receipts stay with caller; mismatch reverts atomically.
- **Depended on by:** Delta result.

```solidity
// L236-L244
for non-IDLE targets collect idle account USDT; return router balance delta;
```

- **What:** `toIdle` does not round-trip already-idle funds; all targets exclude pre-existing stranded router balance.
- **Why here:** Prevents another caller from sweeping donations/stranded funds.
- **Assumes:** USDT balance arithmetic reflects transfers in this call.
- **Establishes:** Returned amount excludes entry balance.
- **Depended on by:** `toIdle`, `toAave`, and `toVenus`.

**Cross-Function Dependencies:**
- `_venusDebt` follows VAI and every entered Venus market (`L253-L267`).
- Aave, Venus, and token contracts are external black boxes at fixed mainnet addresses.
- `nonReentrant` brackets all public actions (`L93-L120`, `L150-L184`).

**Open Questions:**
- Live debt state and allowances for the screenshot account at the attempted block.
- Whether any `EncumberedPositionSkipped` event was emitted during its recovery attempt.

---

## Non-yield strategy dashboard exit path

**Purpose:** Record the reachable owner controls for `StrategyPositionCard` sessions.

**Inputs & Assumptions:** A Ranger/Rebalancer saved session is selected by slug and rendered through `SessionCard` (`apps/web/src/app/dashboard/page.tsx:L111-L118`; `apps/web/src/components/StrategyPositionCard.tsx:L213-L223`).

**Outputs & Effects:** The wrapper displays account assets and runner status; its action component offers finish handoff, revoke, and forget (`apps/web/src/components/SessionCard.tsx:L227-L258`).

**Cross-Function Dependencies:** No call to owner token/native transfer, Pancake decrease/collect, Ophis cancellation, or approval reset is present in this branch: **nothing found**.

**Open Questions:**
- Intended exit semantics for open orders, idle balances, and Ranger's active NFT.
- Whether the product expects users to use a separate external wallet interface; no link/instruction establishing one was found in this card.
