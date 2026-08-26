# 🔐 Security Review — agripinaa

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | ALL / default                                          |
| **Files reviewed**               | `contracts/src/AgripinaaYieldRouter.sol` · `contracts/test/AgripinaaYieldRouter.t.sol` · `contracts/test/fuzz/RouterFuzz.sol`<br>`packages/spikes/contracts/TestUSD.sol` |
| **Confidence threshold (1-100)** | 80                                                     |

---

## Findings

[99] **1. Venus synthetic VAI debt was omitted from the collateral-removal guard**

`AgripinaaYieldRouter._venusDebt` · Confidence: 99

**Description**
The router checked only vToken borrow balances, allowing it to remove Venus collateral backing debt recorded separately in the Comptroller's VAI ledger.

**Fix**

```diff
+ uint256 vaiDebt = VENUS_COMPTROLLER.mintedVAIs(account);
+ if (vaiDebt != 0) return (comptroller, vaiDebt);
  address[] memory markets = VENUS_COMPTROLLER.getAssetsIn(account);
```
---

[98] **2. A mutable Venus Comptroller could silently change the debt domain**

`AgripinaaYieldRouter._venusDebt` · Confidence: 98

**Description**
Reading and trusting `VUSDT.comptroller()` on every unwind let a later market migration replace the debt ledger the immutable router had been reviewed against.

**Fix**

```diff
- address comptroller = VUSDT.comptroller();
+ address comptroller = address(VENUS_COMPTROLLER);
+ address liveComptroller = VUSDT.comptroller();
+ if (liveComptroller != comptroller) revert ComptrollerMismatch(comptroller, liveComptroller);
```
---

[97] **3. Zero-share Venus mints could consume underlying without compensating receipts**

`AgripinaaYieldRouter.toVenus` · Confidence: 97

**Description**
A successful Venus dust mint that rounded down to zero vTokens completed without returning value to the caller.

**Fix**

```diff
  uint256 minted = VUSDT.balanceOf(address(this)) - preMint;
+ if (minted == 0) revert ZeroVenusMint();
  if (!VUSDT.transfer(msg.sender, minted)) revert TransferFailed();
```
---

[96] **4. Aave withdrawal output was not required to match the receipts removed**

`AgripinaaYieldRouter._collectUsdt` · Confidence: 96

**Description**
The router ignored Aave's returned withdrawal amount after taking the caller's exact aToken balance, so an anomalous short withdrawal was not fail-closed.

**Fix**

```diff
- AAVE.withdraw(address(USDT), aBal, address(this));
+ uint256 withdrawn = AAVE.withdraw(address(USDT), aBal, address(this));
+ if (withdrawn != aBal) revert AaveWithdrawMismatch(aBal, withdrawn);
```
---

[94] **5. One encumbered receipt leg blocked every unrelated safe leg**

`AgripinaaYieldRouter._collectUsdt` · Confidence: 94

**Description**
The all-or-nothing unwind reverted idle and debt-free venue processing whenever either receipt balance was collateral for debt, including receipt dust transferred permissionlessly to the account.

**Fix**

```diff
- _requireNoVenusDebt(account);
- if (!VUSDT.transferFrom(account, address(this), vBal)) revert TransferFailed();
+ (address debtSource, uint256 debtAmount) = _venusDebt(account);
+ if (debtAmount != 0) {
+     emit EncumberedPositionSkipped(account, address(VUSDT), debtSource, debtAmount);
+ } else {
+     if (!VUSDT.transferFrom(account, address(this), vBal)) revert TransferFailed();
+ }
```
---

[92] **6. Same-target calls needlessly churned positions and expanded failure surface**

`AgripinaaYieldRouter.toAave` · Confidence: 92

**Description**
Every action unwound both venues before redepositing, so an already-correct target position was exposed to avoidable transfers, debt queries, rounding, and external-call failure.

**Fix**

```diff
- uint256 amount = _unwindAllToUsdt(msg.sender);
+ uint256 amount = _collectUsdt(msg.sender, Target.AAVE);
```
---

[91] **7. Constructor validation did not prove the Comptroller supported the required VAI ledger**

`AgripinaaYieldRouter.constructor` · Confidence: 91

**Description**
A contract-valued but incompatible Comptroller could pass deployment checks and make the router fail only when a user later attempted a debt-guarded unwind.

**Fix**

```diff
- _requireContract(IVToken(vUsdt).comptroller());
+ address venusComptroller = IVToken(vUsdt).comptroller();
+ _requireContract(venusComptroller);
+ IVenusComptroller(venusComptroller).mintedVAIs(address(this));
+ VENUS_COMPTROLLER = IVenusComptroller(venusComptroller);
```
---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [99] | Venus synthetic VAI debt was omitted from the collateral-removal guard |
| 2 | [98] | A mutable Venus Comptroller could silently change the debt domain |
| 3 | [97] | Zero-share Venus mints could consume underlying without compensating receipts |
| 4 | [96] | Aave withdrawal output was not required to match the receipts removed |
| 5 | [94] | One encumbered receipt leg blocked every unrelated safe leg |
| 6 | [92] | Same-target calls needlessly churned positions and expanded failure surface |
| 7 | [91] | Constructor validation did not prove the Comptroller supported the required VAI ledger |

---

## Leads

_None._

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
