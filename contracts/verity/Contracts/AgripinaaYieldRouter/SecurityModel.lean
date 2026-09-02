import Verity.Core

/-!
# AgripinaaYieldRouter security model

Machine-checked model of the security-critical control decisions in
`contracts/src/AgripinaaYieldRouter.sol`:

* terminal venue recipients are always the calling smart account;
* the target leg is not collected and round-tripped;
* debt-encumbered Aave and Venus legs are skipped;
* delta accounting excludes a balance that was already stranded in the router.

External Aave, Venus, and ERC-20 behavior is deliberately outside this model;
those trust assumptions are documented beside this artifact in README.md.
-/

namespace Contracts.AgripinaaYieldRouter

open Verity

inductive Target where
  | idle
  | aave
  | venus
  deriving DecidableEq, Repr

structure Inventory where
  idle : Nat
  aave : Nat
  venus : Nat
  deriving Repr

structure Debt where
  aave : Nat
  venus : Nat
  deriving Repr

structure Rotation where
  recipient : Address
  target : Target
  amount : Nat
  deriving Repr

def collectVenus (target : Target) (debt balance : Nat) : Nat :=
  if target = .venus then 0 else if debt = 0 then balance else 0

def collectAave (target : Target) (debt balance : Nat) : Nat :=
  if target = .aave then 0 else if debt = 0 then balance else 0

def collectIdle (target : Target) (balance : Nat) : Nat :=
  if target = .idle then 0 else balance

def collected (target : Target) (inventory : Inventory) (debt : Debt) : Nat :=
  collectVenus target debt.venus inventory.venus +
    collectAave target debt.aave inventory.aave +
    collectIdle target inventory.idle

def rotate (caller : Address) (target : Target) (inventory : Inventory) (debt : Debt) : Rotation :=
  { recipient := caller, target, amount := collected target inventory debt }

/-- Every successful terminal action names the calling smart account, never an agent-controlled address. -/
theorem rotation_recipient_is_caller
    (caller : Address) (target : Target) (inventory : Inventory) (debt : Debt) :
    (rotate caller target inventory debt).recipient = caller := by
  rfl

/-- No distinct third party can be the modeled recipient of a rotation. -/
theorem no_third_party_recipient
    (caller thirdParty : Address) (target : Target) (inventory : Inventory) (debt : Debt)
    (h : thirdParty ≠ caller) :
    (rotate caller target inventory debt).recipient ≠ thirdParty := by
  simpa [rotate] using Ne.symm h

/-- Moving to Venus leaves an existing Venus receipt-token leg in place. -/
theorem venus_target_is_not_collected (debt balance : Nat) :
    collectVenus .venus debt balance = 0 := by
  simp [collectVenus]

/-- Moving to Aave leaves an existing Aave receipt-token leg in place. -/
theorem aave_target_is_not_collected (debt balance : Nat) :
    collectAave .aave debt balance = 0 := by
  simp [collectAave]

/-- Moving to idle does not pull idle USDT through the router. -/
theorem idle_target_is_not_collected (balance : Nat) :
    collectIdle .idle balance = 0 := by
  simp [collectIdle]

/-- Any Venus obligation prevents the model from moving the Venus receipt-token leg. -/
theorem venus_debt_skips_leg
    (target : Target) (debt balance : Nat) (h : debt ≠ 0) :
    collectVenus target debt balance = 0 := by
  simp [collectVenus, h]

/-- Any Aave debt prevents the model from moving the Aave receipt-token leg. -/
theorem aave_debt_skips_leg
    (target : Target) (debt balance : Nat) (h : debt ≠ 0) :
    collectAave target debt balance = 0 := by
  simp [collectAave, h]

/-- Solidity's `finalBalance - entryBalance` distributes only this call's delta. -/
theorem preexisting_router_balance_is_excluded (entryBalance callDelta : Nat) :
    (entryBalance + callDelta) - entryBalance = callDelta := by
  omega

end Contracts.AgripinaaYieldRouter
