# Agent execution investigation — 2026-09-05

Started from the September 4–5 session and production runner revision
`18893750100e7e5afa314c6958a0029e26d7d881`. The web app already contained
`eefa96d`, which corrected funding status 300 but did not fix its cause.

## Confirmed defects and fixes

| Defect | Evidence | Fix |
| --- | --- | --- |
| First merchant-paid activation fails before executing the funding batch | Relay call `0x2fac24d37b00ed18210e40536aed1dfcf3c504346426caa0995fab4a2c64c689` is status 300 with no transaction. Local fork trace returns `Unauthorized()` (`0x82b42900`) from the payer's `pay` call. The merchant supplied a 98-byte registered-key signature although this key was not authorized in the payer account. | Use the native 65-byte signature when the private key belongs to the payer EOA. Preserve the wrapped signature for a delegated key. Keep request-policy and exact-quote validation before signing. |
| Harvester and Steward cannot read rates | Production repeatedly reports `RPC quorum mismatch`. Independent providers return the same block with different serialized `size` metadata; one live sample returned 66134 and 66135. Follow-up production checks also exposed different JSON property ordering between BNB Chain and other providers. | Exclude serialized size from block comparison and canonicalize object property order recursively. Continue comparing all other fields, preserving array order and requiring two providers. |
| Historical read requests silently become latest-state reads | The quorum wrapper overwrote the requested `blockNumber` on contract reads, simulations and code reads. | Preserve explicit block numbers; test the actual outgoing RPC parameters. |
| A transient runner failure can delay a 6-hour or 12-hour agent until the following full interval | Backoff was decremented only on the next normal interval, and that tick returned without retrying. A 30-minute backoff could therefore take 12 or 24 hours. | Schedule the retry from completion, cap it at 30 minutes, reset after success, and prevent overlapping ticks. |
| Managed strategy writes and retired-grant recovery can remain pending permanently | These two backend status readers still recognized only status 500 as numeric failure, despite the earlier frontend fix. | Treat status 300 and higher as failed; also recognize confirmed status 201 in managed execution. |
| An own-capital halt can block unrelated yield mandates | Both the managed-yield loop and its tick checked the demonstration account's halt without considering its scope. | Honor global halts while leaving account-specific halts scoped to their own portfolio. |

## Verification and limits

- All 1,011 tests and workspace type checks pass. The production build passed;
  the live website smoke suite passed all 24 checks.
- Runner fixes are deployed at `78a7cfb`. At 18:02:22 UTC both Harvester and
  Steward completed their ticks successfully: Harvester held its Aave position
  and Steward held its Venus position. Both read the same live market rates.
  Runner and tunnel services were active, and health reported all eight agents.
- The funding-signature patch is deployed to the production website and runner.
  After explicit user approval, unsigned preparation through
  `https://agripinaa.vercel.app/api/funding/merchant` passed for the affected
  account: 15 calls, a native 65-byte fee signature, and cryptographic recovery
  of the published fee-payer address. Initial diagnostic requests omitted zero
  call values and were rejected; normalizing these as the application's SDK
  already does resolved the diagnostic error. No application change was needed.
- Added regressions for each changed behavior, including native signature recovery
  and preserving wrapped signatures when the signer is not the payer EOA.
- On a local BSC fork, replacing only the original payer signature wrapper got
  past fee payment and user signature verification. The old swap quote then
  failed its minimum output after market movement.
- A freshly quoted BTCB funding batch for the affected account executed
  successfully on the local fork: 15 calls and 778475 gas, including conversion,
  native reserve, venue approvals and initial KeyStore registration. This was
  a self-call simulation of the funding batch, separate from the signed-intent
  signature check; it is not a new production activation receipt.
- No user funding transaction was signed or broadcast during this investigation.
  A new browser passkey confirmation is required to submit a fresh activation.

## Follow-up: the browser still reported a failed call as pending

The user's subsequent retry exposed a missed deployment defect. The account's
only relay submission remained `0x2fac24d37b00ed18210e40536aed1dfcf3c504346426caa0995fab4a2c64c689`,
status 300, with no receipt. The installed SDK returned `FAILED` in 276 ms, but
production deployment `dpl_738eu2ceZuJKjkh2KD9JA2E6En1p` served chunk
`347-419045e5c14fa0ed.js` whose SDK poller recognized only status 500. That code
swallowed status 300 until its four-minute deadline, then returned `PENDING`.
The local production build also retained the old implementation. Passing
source tests and unsigned preparation did not verify this browser path.

- Webpack's persistent cache now explicitly tracks every pnpm patch file,
  invalidating cached dependency code when a patch changes without a version bump.
- Both activation wizards use the existing one-shot status reader for saved
  submissions instead of the four-minute SDK wait. Network failures remain
  errors, not a fabricated pending transaction.
- Passkey recovery clears a saved funding checkpoint only after the relay proves
  failure. Pending, confirmed and unreadable submissions remain protected.
- Every production build now executes the emitted SDK poller with statuses
  300, 400, 500 and 201. This check reproduced `PENDING` on the old local and
  live bundles and passed after rebuilding against the existing cache.
  Run `node scripts/check-wallet-bundle.mjs https://agripinaa.vercel.app` from
  `apps/web` to check the JavaScript actually served by production.

## Production states that were not execution defects

- BTC Grid's BTCB and USDT were withdrawn at the user's explicit request in the
  preceding session (September 4, 15:16 and 15:18 UTC). Its zero inventory was
  independently confirmed. No capital was replenished or moved back.
- Both Guardians continued reporting healthy positions. Ranger continued
  checking its LP range. Rebalancer correctly skipped a roughly $0.30 adjustment
  below its published $1 minimum.
- The production managed registries were empty at inspection. A running public
  status endpoint does not prove that an unfinished passkey activation has
  reached the runner.

## Unresolved: subsequent signed funding attempts rejected off-chain

After the browser fix, the user submitted two fresh activations:

- `0x772f66b24bfc9341566d8d5cc9b762db4380c20b29155ff7ecf7d3c476b23e48`
- `0x30b4ae65682e966f05071fb60d0f6268ae80d0a9e90d9ed7790b46095dae6379`

Both returned relay status 300 and no transaction hashes or receipts. The UI's
"reverted on-chain" and "No funds were moved" text was not justified by the
SDK result alone. Shared approval/withdrawal error handling now reports relay
failure without claiming an on-chain revert or a particular balance outcome.

The latest **actual signed intent**, including the native 65-byte payer signature,
successfully returned `0x00000000` from Orchestrator execution on a local Anvil
BSC fork. A second trace used the complete EIP-7702 envelope, both signed
authorizations (payer nonce 8, account nonce 0), quoted gas limit 1,762,899 and
quoted gas fees, with **no account state overrides**. It also succeeded.
Neither trace broadcast a transaction. This does not prove the relay's own
BSC RPC simulation or transaction submission succeeds.

Read-only chain checks still show account nonce 0, no delegated code, zero BNB,
and the original 25,976,153,706,966 BTCB base units. The relay's public status
endpoint exposes no failure reason beyond status 300. The exact rejection cause
remains unresolved; a public-RPC simulation of the signed payload requires the
user's approval, or the relay operator must supply its failure logs. Do not
describe the activation as fixed based on the local simulation.
