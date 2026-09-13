## `DashboardPage` recovery rendering in apps/web/src/app/dashboard/page.tsx (L60-L165)

**Purpose:** Presents saved sessions and unfinished funding steps; exposes passkey recovery when browser records are missing.

**Inputs & Assumptions:**
- Saved sessions and checkpoints are browser-local inputs. `refresh` correlates chain/account/agent, registration status, expiry, and checkpoint timestamps (L66-L94), unchanged by makeover.
- Recovery components each have exactly one production render site (L158-L159), both still gated on `dashboard !== null` (L153).

**Outputs & Effects:**
- The recovery components move from above sessions into a native `details` below them (L153-L161). They are mounted even while details is closed; no conditional mount on `open` or `onToggle` exists.
- No network or wallet action is tied to opening the disclosure. The existing initial dashboard refresh remains a timer effect (L96-L99).

---

**Block-by-Block:**

```tsx
// L153-L161
{dashboard !== null && (
  <details>
    <summary>Missing an agent or recovering an account?</summary>
    <p>Use the same passkey to find a funded account. Do not deposit again.</p>
    <MissingActivationRecovery />
    <LostRangerRecovery />
  </details>
)}
```
- **What:** Adds one navigation disclosure after the existing cards.
- **Why here:** Normal balances/actions precede exceptional recovery controls.
- **Assumes:** Users discover and open native details; source establishes keyboard-native semantics, not user comprehension.
- **Establishes:** Existing recovery forms are retained without automatic signing on mount/open.
- **Depended on by:** The same two recovery components as baseline.

---

**Cross-Function Dependencies:**
- `MissingActivationRecovery` (L266-L325): unchanged state/form handler; selected agent routes to `/agent/56/<tokenId>/activate` on explicit submission (L287-L298). It does not sign or transfer.
- `LostRangerRecovery.findAccount` (L336-L358): only its button calls it (L448); passkey-derived wallet/account are followed by runner snapshot and live account position reads (L341-L345). No effect calls this automatically.
- `LostRangerRecovery.recover` (L360-L429): only explicit form submission calls it (L458-L461). Validates destination syntax/NFT ID (L364-L372); verifies destination and owner before mutating (L381-L385); revokes all account sessions before close/transfer (L387-L389); rereads balances and retains BNB reserve, withholding BNB when Ranger absence is uncertain (L392-L408). Errors preserve partial-recovery messaging (L418-L425). All statements are unchanged in diff.
- `assertSafeWithdrawalDestination` (`managed.ts:L208-L228`) invokes static destination policy, queries configured RPC bytecode, and requires destination quorum. `sendNativeOut` (L254-L264) rechecks destination immediately before passkey execution and requires confirmed relay result. Neither helper changes.
- `assertRangerPositionOwner` (`strategy-recovery.ts:L61-L72`) obtains quorum owner; `stopAllAccountSessions` (L181-L212) revokes every authoritative active key and rereads absence before updating local records. `closeRangerPosition` (L219-L271) repeats owner/pinned factory/pair checks and TWAP/slippage prerequisites before execution. `recoverStrategyTokens` (L274-L297) rereads assets, rechecks destination and requires confirmed transfer. No makeover diff in this module.
- `ManagedPositionCard` and `StrategyPositionCard` diffs contain classes/display copy only; their withdrawal function bodies have no diff. Dashboard keeps exact routing to these cards at L135-L142.

**Open Questions:**
- Source cannot establish whether first-time users locate the collapsed recovery section; browser usability validation remains appropriate.
- SDK/chain execution, RPC availability, and actual wallet access were not exercised in this read-only context task. These records establish changed reachability and unchanged handler ordering, not end-to-end production recovery success.
