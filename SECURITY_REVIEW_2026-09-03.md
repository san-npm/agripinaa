# Agripinaa recovery-path security review

Date: 2026-09-03

Baseline: `17d4c70` (`main`) plus the recovery patch in this working tree

Scope: saved-session authority, managed-strategy recovery, withdrawal destination validation, Ranger exit construction, and `AgripinaaYieldRouter.sol`

## Executive summary

The screenshots show two separate conditions, not one failed transfer:

1. the address entered as the withdrawal destination,
   `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364`, is the configured Pancake V3
   Nonfungible Position Manager contract and is intentionally rejected by the
   EOA-only withdrawal policy; and
2. revoked or expired non-yield sessions had no owner recovery workflow, so
   idle assets and Ranger NFT liquidity remained visible but could not be
   recovered from their cards.

The patch adds a resumable owner recovery path and moves destination validation
before any session revocation or venue mutation. The recovery sequence now:

1. requires an EOA destination confirmed by an RPC quorum;
2. reconstructs and revokes every active non-admin account session from matching
   account and KeyStore state, including sessions absent from local storage;
3. rechecks that no session remains;
4. closes and collects a Ranger position through the pinned Pancake manager,
   with an independently reproduced snapshot, TWAP check, deadline, and
   per-leg minimums;
5. clears every pinned managed-strategy allowance on the shared account; and
6. transfers exact freshly read strategy-token balances while retaining native
   BNB for later recovery gas.

No transaction was submitted during this review.

## Review methods

- Trail of Bits audit-context construction and security-focused differential
  review of the working-tree patch against `17d4c70`.
- Pashov Solidity Auditor's twelve review lenses, consolidated across three
  parallel reviewers because only three reviewer slots were available. The
  Solidity scope was `contracts/src/AgripinaaYieldRouter.sol`; all reviewers
  returned `NO FINDINGS`.
- A scoped Verity/Lean model for the YieldRouter control decisions, checked with
  Verity commit `cca73c39a4f49176fc01c570febb31ea891b3898` and Lean `v4.31.0`.
  This is a semantic model, not a byte-for-byte equivalence proof of the Solidity
  source or deployed bytecode. Its explicit trust boundary is documented in
  `contracts/verity/README.md`.

## Findings fixed during differential review

### High: local browser records were not an authority boundary

An early recovery draft revoked only sessions present in the current browser's
storage. The smart account is shared by multiple saved strategies, and a session
created in another browser could therefore remain authorized while recovery
moved inventory.

The final patch joins the account's authoritative key descriptors to the public
KeyStore at a consistent provider snapshot, fails closed on missing, ambiguous,
or unsupported active session keys, revokes every resolved live session, then
re-enumerates before proceeding. Local records are updated only after the
on-chain check is empty.

### High: a single RPC could weaken Ranger exit bounds

An early recovery draft obtained the position metadata, manager configuration,
pool tick, TWAP observations, and simulated exit from one fallback RPC. A
dishonest provider could return a forged low quote and reduce the meaningful
slippage protection of the subsequent transaction.

The final patch executes the complete snapshot against distinct BSC RPC
operators at one selected block and accepts only an identical quorum. The
transaction is not submitted if the providers disagree or if the position,
manager, factory, WBNB address, pair, pool, quote, or TWAP policy is invalid.

## Relevant correctness fixes

- Contract destinations are rejected before passkey recovery or revocation and
  rechecked immediately before the transfer. A bad address no longer stops an
  agent as a side effect.
- Revoked and expired Ranger/Rebalancer/Grid/Guardian cards now expose owner
  recovery instead of only `Forget`.
- A Ranger NFT is decreased and collected before token sweep. Fee-only positions
  are collected even when liquidity is already zero.
- `Forget` stays disabled while live assets, an NFT, an unknown position state,
  or an unconfirmed on-chain revocation remains.
- The recovery phases are idempotent enough to retry after an already-confirmed
  earlier phase; later calls are not sent after a failed or pending result.

## Residual risks and operational constraints

- The destination policy deliberately supports EOAs only. Safe-style contract
  wallets require a separately designed receiver-validation flow.
- Ranger's 90% per-leg minimum matches the existing automated exit policy but
  permits up to 10% deterioration from the quorum snapshot. A tighter,
  user-configurable recovery tolerance would reduce MEV exposure.
- External protocol behavior, proxy upgrades, RPC operator independence, the
  passkey/relay stack, ERC-20 compliance, and Verity-to-Yul/`solc` correctness
  remain trust boundaries.
- Token balance reads can cause a revert or partial resumable sweep if stale,
  but cannot redirect assets: the destination and transfer calldata are fixed
  by the owner flow, and the live destination check is repeated.
- The observed sessions were already revoked or expired. Restoring autonomous
  operation requires creating fresh mandates after recovery; this patch does not
  silently reauthorize an agent.

## Verification record

- Session-kit unit tests: 43 passed.
- Web unit tests: 380 passed.
- Foundry BSC-fork tests: 20 passed.
- Whole-workspace TypeScript check: passed.
- Web lint and production build: passed.
- Verity/Lean proof check: passed with no errors and no `sorry` declarations.
- Live BSC checks were read-only; no user transaction or approval was broadcast.
