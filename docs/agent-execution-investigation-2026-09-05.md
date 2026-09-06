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
remains unresolved. Do not describe the activation as fixed based on the local
simulation.

After explicit user approval, the complete signed EIP-7702 envelope was also
simulated using `eth_call` on `https://bsc-dataseed.bnbchain.org`. It returned
the successful Orchestrator result (`bytes4(0)`), with both authorizations,
the quoted gas limit and fees, and no account state overrides. No transaction
was broadcast. This is evidence at the current chain state, not a replay of
the relay's original failure.

The same provider does not expose `debug_traceCall`. Historical `eth_call`
at blocks 120159263, 120159264 and 120159265 (surrounding submission timestamp
1788633215) returned `missing trie node`, so submission-time execution could
not be verified there.

The next required evidence is the Altana operator's failure log for call
`0x30b4ae65682e966f05071fb60d0f6268ae80d0a9e90d9ed7790b46095dae6379`:
the underlying error before status 300, the preflight block/RPC response,
actual sending account and fee parameters, and any signing/broadcast error.
The public API does not expose these. No retry or transaction broadcast is
authorized by the simulation approval.

## Alternate sender pilot (local implementation, not deployed)

Following approval to implement/test an alternate path without moving existing
funds, `apps/agents/src/recover-funding.ts` adds an operator-only recovery command.
It reuses the funding policy, gas cap, durable state writer and known-transaction
handling. Simulation is the default; a separate gas wallet and explicit broadcast
flag are required for any send. No public endpoint or browser integration was added.

The full ten-call funding envelope succeeded in `eth_call` on a fresh local BSC
fork using disposable EOA user/payer/sender keys, local USDT/BNB fixtures and the
deployed contracts. Tests also reject invalid user/payer signatures and excessive
fees, handle an already delegated payer without reauthorization, and refuse an
already initialized user. No transaction was broadcast, even on the fork. This
is not a live passkey end-to-end acceptance test.

The current user's old intent is no longer eligible: its signed registration
value was 643,173,666,243,097 wei, while the later fee read required
648,140,581,995,046 wei. The recovery policy stopped before signing. This is a
stale-quote limitation, not proof of what caused the original status 300.
Historical fork replay through PublicNode also requires archive access, which
was unavailable. Fresh quotes and a new user signature are needed; no additional
agent deposit is indicated by this finding.

Repository tests and `pnpm typecheck:ci` passed. Operational prerequisites and
remaining browser/live-verification work are in `docs/funding-recovery.md`.
The marketplace must not be described as restored on the strength of this pilot.

## September 6: browser sender integration and registration-fee consistency

The subsequent implementation connects the alternate sender to both approval
flows through the existing activation checkpoint. It is a disabled-by-default,
single-account pilot on the existing runner, not an automatic provider fallback.
The browser saves a deterministic, deadline-bound ID before submission; the runner
saves signed outer transaction bytes before sending. Retry/reload polls that ID
without creating another transaction. Confirmation requires the exact successful
Orchestrator event and three block confirmations. Missing receipts remain uncertain.

Funding now signs the same 2%-buffered registration budget that its reserve quote
covers. The SDK no longer rereads a different initial registration amount for this
flow. Merchant checks use a fresh live minimum and retain their fee caps; tests
accept a 1% fee rise and reject an uncovered 3% rise. Other SDK registration paths
also buffer the current fee. This fixes quote consistency, not the unexplained
historical hosted-relay rejection.

Verification: 1,023 repository tests, all workspace type checks, the production
webpack build and emitted-bundle checks passed. An actual SDK/headless-passkey
test with mocked RPCs checks the quoted budget, signature, checkpoint-before-send,
direct status polling and no hosted fallback after a lost submission response.
The full ten-call transaction again passed a fresh local BSC fork simulation;
invalid user and payer signatures were rejected. No live or fork transaction was
broadcast, and no production wallet key or balance was changed.

Neither the web/runner integration nor its live flag has been deployed in this
implementation step. Altana still supplies merchant preparation, capabilities and
authorization reads; only submission/status have an alternate path. Live activation,
session grant, runner execution and withdrawal are still required acceptance checks.

## September 6: approved deployment and gas-wallet preparation

After the user approved deployment and a one-account live test capped at 0.0002 BNB
in gas, commit `b0678e60aa3eda93378416d93a63a02ed0c5c1ce` was pushed and deployed
to the web and existing Aleph runner. Production deployment
`dpl_8PGN2BXbDhofPapzoq3Z6h8PGFVs` is Ready. The live browser-bundle check passed;
runner health lists all eight agents. The new gateway returns disabled funding mode
and successful read-only health/capabilities responses. The BTCB fee quote is live.

The separate gas wallet was created locally and funded from the project's existing
`spike-a` funding wallet with 0.00015 BNB. Transaction
`0x063d635b03bf639ab1ad8c5325109880ded22ee475cad04843d8629cdccbce82` succeeded,
costing 0.00000105 BNB in gas. The affected user's nonce remains 0 and their BTCB
balance remains 25,976,153,706,966 base units. No activation transaction was sent.

Automated review blocked the full deployment script's wallet-key export. Code-only
deployment succeeded without copying any credentials. Direct sending remains off;
installing only the new dedicated key on the existing runner requires explicit
approval. `docs/funding-recovery.md` records the exact key destination and retained
gas-transfer journal. Do not fund again, clear checkpoints, or claim live restoration.

## September 6: dedicated key installed after explicit approval

The user explicitly approved copying only the newly created gas-wallet key to the
existing Aleph runner. The single file was transferred over pinned SSH, verified
to derive `0x270C1136Eab831b0D5c18aA1BBCcf87d95bd14F7`, and checked at mode 0600.
No other wallet key or the user's passkey was transferred. The dedicated gas
balance was rechecked at 0.00015 BNB; no additional funding transfer was sent.

A systemd drop-in enables the sender only for the approved account and points to
the installed key. After restart, the production funding route returns enabled for
that account and disabled for an unrelated address. The runner and tunnel are
healthy. No direct activation journal or lock exists; the user still needs to
refresh the existing activation page and authorize a fresh quote with their passkey.
An old failed checkpoint must be resolved with the existing status-check button,
not by depositing again or manually clearing browser storage. End-to-end live
activation, mandate, execution and withdrawal remain unverified.

## September 6: direct sender omitted the passkey signature envelope

The user's first direct attempt reached `wallet_sendPreparedCalls` but failed before
the signed-transaction journal was created. The user, payer and dedicated sender
nonces remained 0, 8 and 0 respectively. No activation transaction was submitted.

Replaying the exact user-reported request through `signedDirectFunding` and
`prepareFundingRecovery` passed request/policy/authorization/gas checks, but BSC
`eth_call` returned `0xfbcb0b34` (`VerificationError()` in the installed Orchestrator
ABI). Porto `signCalls` deliberately returns an **unwrapped** main-bundle signature
(`wrap: isPrecall`); the hosted relay normally adds the key hash and prehash byte.
Our direct sender incorrectly assigned the raw WebAuthn bytes to `intent.signature`.
This is a bug in the new sender, not evidence about the earlier hosted rejection.

The fix reuses Porto's `Key.wrapSignature` for the validated WebAuthn key. It adds
`Key.hash(key)` and `prehash=false` without changing the user's signed calls, nonce,
amounts, payer signature or either delegation authorization. The exact original
request, with its original 1,784,140 gas limit, then passed full public BSC simulation
with no state overrides. The patched parser itself was rerun and passed too. These
were read-only simulations; sender-deadline validation was evaluated at the original
submission time for diagnosis only, not bypassed in the service or used to broadcast.

Regression assertions now check the exact 33-byte framing on an actual SDK-generated
headless-passkey request and that native payer signatures remain unchanged. The old
test only checked that the RPC parsed and mocked the contract call; it did not
exercise contract verification, so it missed this error. The browser now suppresses
viem's full signed-request dump on direct execution failures, while retaining the
saved checkpoint. Server logging allows only the fixed simulation-error label and
bytes4 selector, never arbitrary RPC payloads. Workspace tests and type checks pass.
