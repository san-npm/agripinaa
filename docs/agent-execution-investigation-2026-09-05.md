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

- All 1,010 tests and workspace type checks pass. The production build passed;
  the live website smoke suite passed all 24 checks.
- Runner fixes are deployed at `78a7cfb`. At 18:02:22 UTC both Harvester and
  Steward completed their ticks successfully: Harvester held its Aave position
  and Steward held its Venus position. Both read the same live market rates.
  Runner and tunnel services were active, and health reported all eight agents.
- The funding-signature patch is deployed to the production website and runner.
  A direct unsigned preparation test through the website was blocked by automatic
  approval review because it would send the account's activation details and
  passkey public key to the public endpoint. It was not executed or bypassed;
  explicit approval is needed for that additional test.
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
