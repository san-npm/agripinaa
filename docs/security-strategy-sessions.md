# Public strategy-session security boundary

This document covers the six public managed paths that do not use
`AgripinaaYieldRouter`: Grid, BTC Grid, Guardian, Venus Guardian, Ranger and
Rebalancer. Harvester and Steward have a stronger, separate model documented in
[security-router.md](./security-router.md).

## User-visible boundary

Activation creates or recovers a dedicated Altana passkey smart account. The
user should put only the assets assigned to that one strategy in it. The
strategy session is time-bounded and revocable, but while valid it can control
the assets the account has approved to its fixed protocol venues.

This isolation is a real capital boundary, not marketing copy. It is also the
reason these six paths do **not** claim the yield routers' drain-proof property:
CoW orders and Pancake V3 calls contain recipient and amount fields. A
compromised manager key could misuse those fields within the approved strategy
inventory even though it cannot directly call an ERC-20 transfer or approval.

## Canonical authority

The browser builds policy only from
`packages/shared/src/managed-strategies.ts`. The public runner handoff rebuilds
the same policy and verifies the account's live authorization before storing
it. It rejects a different manager key, target, selector, order, spend ceiling,
expiry, chain, or ERC-1271 checker.

Every strategy carries the canonical USDT and native-BNB ceilings. The native
ceiling covers transaction gas and any native value attached to an allowlisted
call; it is not a gas-only permission. Ranger also carries a fixed WBNB ceiling
because Pancake V3 `mint` spends both inventory legs through the account;
omitting that permission would make its first mint fail closed at the smart
account.

No strategy session receives the ERC-20 `approve(address,uint256)` selector.
Venue approvals are a separate passkey-admin transaction to these fixed
addresses only:

- the CoW/Ophis vault relayer for trading inventory;
- the Aave V3 BSC pool for the Aave repair reserve;
- Venus vUSDT for the Venus repair reserve; and
- PancakeSwap V3's non-fungible position manager for Ranger inventory.

For Ophis agents, the only account-local ERC-1271 checker is the BSC CoW
Settlement contract. The Ophis adapter submits smart-account orders using the
`eip1271` signing scheme. The runner stores only the SDK session permissions;
checker authority is independently read from the account on every handoff.

## Agent-specific authority

| Agent | Delegated action | Capital at risk if its manager key is compromised |
|---|---|---|
| Grid | CoW order signing for approved WBNB and USDT | Approved WBNB/USDT in the dedicated account |
| BTC Grid | CoW order signing for approved BTCB and USDT | Approved BTCB/USDT in the dedicated account |
| Guardian | Aave `repay` | The dedicated USDT repair reserve; a malicious call can repay another Aave account |
| Venus Guardian | Venus vUSDT `repayBorrow` | The dedicated USDT repair reserve, applied to this account's Venus debt |
| Ranger | Pancake V3 `mint`, `decreaseLiquidity`, `collect`, plus CoW signing | The approved WBNB/USDT inventory and managed position proceeds |
| Rebalancer | CoW order signing for approved WBNB and USDT | Approved WBNB/USDT in the dedicated account |

Guardian activation never supplies collateral or opens debt. It adopts an
existing Aave position. The managed context permanently bypasses the module's
own-capital demo setup, and a regression test asserts that behavior. Venus
Guardian likewise exposes only its repay call.

## Operational controls

- Each agent has a distinct manager identity; public addresses are pinned in
  the shared registry and private keys stay in the gitignored `wallets/`
  directory and on the runner host.
- Stored mandates are mode `0600` inside a mode `0700` data directory.
- The runner rechecks revocation and expiry before every sweep, namespaces
  state and action breakers per user account, and bounds concurrent work.
- A failed browser handoff leaves the locally saved grant visible for revocation.
- Revoking a session stops its calls and ERC-1271 signatures. Fixed ERC-20
  allowances remain on-chain until the account owner separately changes them;
  without a valid account signature they are not authority by themselves.

The future hardening path for trading and LP agents is an immutable guard
contract that binds every order/call recipient to the smart account, matching
the yield routers' guarantee. Until then, the dedicated-account inventory is
the explicit maximum-loss boundary.
