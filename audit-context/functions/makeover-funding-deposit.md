## `FundingDeposit` in apps/web/src/components/FundingDeposit.tsx (L18-L180)

**Purpose:** Shows the selected deposit asset, exact allocation, funding progress, and the one-transfer address before preparation. It is shared by both managed-yield and non-yield strategy activation.

**Inputs & Assumptions:**
- Props are internal presentation data (semi-trusted because balances/quotes originate from RPC/API and checkpoints from browser storage). `FundingAsset`, bigint amounts, and status shape are typed at L30-L41.
- Plan/status coupling is assumed, not enforced by the prop type (L36-L37). Established in both production callers: `ManagedWizard.tsx:L1347-L1363`, `StrategyWizard.tsx:L824-L840`; there are exactly two production callers, plus one test renderer.
- Restored checkpoint shape is checked by `funding-checkpoint.ts:parseCheckpoint` (L134-L215), and every checkpoint requires a plan (L38-L59). Both connect functions restore the asset from that same plan (`ManagedWizard.tsx:L245-L250`, `StrategyWizard.tsx:L205-L210`).
- Display uses 18 decimals (L138-L149); confirmation of token decimals is a shared token-manifest dependency, not a new makeover rule.

**Outputs & Effects:**
- React markup; exact values formatted using `fromBaseUnits` at L138-L149. Local copied-state and clipboard write only at L53-L57. No funding submission, checkpoint write, signer, or withdrawal API is called by this function.
- Asset buttons call the supplied callback, disabled when `locked` (L64-L69). Both production callbacks independently reject selection while busy or prepared (`ManagedWizard.tsx:L1359-L1362`, `StrategyWizard.tsx:L836-L839`).

---

**Block-by-Block:**

```tsx
// L44-L51
const gross = preparedPlan?.grossInput ?? balances[asset];
// reserve/relay allocation and strategy capital prefer the same preparedPlan
```
- **What:** Snapshot amounts win over live balances after preparation.
- **Why here:** All subsequent displays and the large-allocation warning share those values.
- **Assumes:** The caller has not combined a plan for one asset with another selected asset. Both callers restore the plan input and lock selection (references above).
- **Establishes:** The makeover does not recompute or round stored funding amounts differently.
- **Depended on by:** Allocation table (L129-L153) and majority warning (L155-L161).

```tsx
// L84-L109, L111-L127
{preparedPlan && preparationStatus && (/* saved-status notice */)}
{!preparationStatus && <div>{/* send once and copy address */}</div>}
```
- **What:** The new condition removes deposit instructions for submitted/confirmed preparation. The existing notice still checks both props.
- **Why here:** The address box cannot invite a second transfer while a saved preparation exists.
- **Assumes:** Plan/status coupling, established by the two callers rather than component-local validation; `nothing found` locally that rejects an inconsistent pair.
- **Establishes:** With either permitted status the address box is absent. Status omission still renders the box.
- **Depended on by:** Existing wizard status actions; labels remain determined by `preparedFunding?.status` (`ManagedWizard.tsx:L1219-L1231`, `StrategyWizard.tsx:L740-L754`).

```tsx
// L155-L175
// Majority-allocation warning and quote error remain outside disclosure.
<p>Fees and gas are paid from your deposit. Agripinaa does not sponsor gas.</p>
<details><summary>How funding and fees work</summary>...</details>
```
- **What:** Only the longer mechanics explanation moves behind a disclosure. Exact deductions, net capital, warning, and errors remain visible.
- **Assumes:** Native disclosure behavior. There is no handler on this details element.
- **Establishes:** Expanding fee explanation has no application-side effect.

---

**Cross-Function Dependencies:**
- `fundingGasQuote`/`fetchFundingGasQuote` (internal, `funding-bootstrap.ts:L134-L178`) checks asset, pinned fee payer, expiry, registration fee ceiling/count, and sum relationships. `fundingGasQuoteIsCurrent` (L181-L188) gates fresh signing in both wizards (`ManagedWizard.tsx:L397-L405`, `StrategyWizard.tsx:L354-L364`). No changes in this helper file.
- Funding checkpoint path is unchanged: each wizard reserves storage before approval, records submission before later receipt confirmation, and refuses a new funding plan while a prepared/recovered state exists (`ManagedWizard.tsx:L348-L499`, `StrategyWizard.tsx:L315-L428`). Exactly one production caller each of `approveRouter` and `approveStrategyVenues`; exactly two production callers each of checkpoint recovery, reservation, and pause helper; six `saveFundingCheckpoint` call sites across those two wizards.
- `approveRouter` (`managed.ts:L141-L168`) and `approveStrategyVenues` (`managed-strategy.ts:L25-L65`) append pinned approvals and route through `executeFunding`. The latter chooses direct versus Altana sender before signing and has no direct-to-Altana fallback on error (`funding-execution.ts:L9-L46`). Direct mode invokes the caller's durable checkpoint callback in `onBeforeSubmit` (L29-L32).
- Pending status parsing checks exact calls ID and transaction hash shape (`session-relay-recovery.ts:L23-L62`). Unknown confirmation without a hash remains pending. Both wizard resume branches require success and `receiptProvesFundingMainBatch` before marking confirmed (`ManagedWizard.tsx:L349-L390`, `StrategyWizard.tsx:L316-L351`). Receipt witness logic (`funding-receipt.ts:L25-L49`) checks account-scoped WBNB withdrawal, except zero native reserve requires no such witness. These paths are unchanged, not re-proven chain invariants here.
- Grant/persistence/handoff blocks are unchanged (`ManagedWizard.tsx:L1067-L1200`, `StrategyWizard.tsx:L557-L715`). New native step UI does not enter those functions.

**Open Questions:**
- Closed during review: the updated rendering test supplies paired plan/status inputs and asserts both banners, persisted gross/strategy allocations after live balance becomes zero, all four locked asset selectors, confirmed-only receipt links, and absent deposit instructions (`tests/funding-disclosure.test.ts:L30-L44`). The earlier statement that the test omitted `preparedPlan` is superseded. These assertions cover presentation, not persistence or live execution.
- Browser clipboard permissions may reject copy (L54); this existing path is outside the changed visibility logic.
- SDK execution internals and adversarially modified browser journals were not independently re-audited; no live signing or RPC submission was performed.
