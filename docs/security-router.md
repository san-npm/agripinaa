# Router security

Managed yield is the only Agripinaa feature that touches a user's own capital.
It works by granting an agent a session key on the user's smart account, scoped
to one contract: `AgripinaaYieldRouter`
([`contracts/src/AgripinaaYieldRouter.sol`](../contracts/src/AgripinaaYieldRouter.sol)).
This document states what that session key can do if it is stolen outright, and
cites the file, the test, or the address behind each claim so a reviewer can
check it rather than take it.

Debt-complete version-3 deployments on BNB Smart Chain
(`packages/shared/src/contracts.ts`):

| Managed token | Address | Block | Runtime hash |
| --- | --- | ---: | --- |
| USDT | `0x67c0005C2a9709a28DA42cEC9b11b8a7201B4C22` | 118230700 | `0xc20d8eb8623f79a688daa29414adc64dddd48634a68f46169cd871105cdd1f16` |
| USDC | `0x4A2E2817736D8497EeB4296dd5e51ECAeA427f72` | 118230776 | `0x07a4f5743bffe23fd40cae068261a1d34b69e9362563c7a97ed5b0a4cb66fe1c` |

Both creation receipts succeeded on 2026-08-26, every immutable getter was
read back against its configured venue, and the runtime hash for each address
matched through two independent RPC providers. A version label alone cannot
enable a router: the manifest pins the runtime bytecode hash, and the browser
and runner both compare live code plus `DEBT_GUARD_VERSION()` before any
value-moving action. Contract custody and bounded recent raw
router activity are public at [`/funds`](https://agripinaa.vercel.app/funds);
permissionless router events do not prove a managed mandate or a particular
agent.

## Threat model

The adversary holds the agent's session key, completely. Assume the runner VM
was taken, the key was exfiltrated, and the attacker can call anything the
session is scoped to, in any order, as often as they like, until the session
expires or the user revokes it.

In scope: what that key can move, and where it can move it to.

Out of scope, and stated rather than papered over: a compromised owner passkey
(that is the account itself, not a session), a compromised lending venue, an
oracle failure at Aave or Venus, a stablecoin depeg, and the yield the user does
or does not earn while deposited. A session key is a delegation of one narrow
power; it is not a guarantee about the venues underneath.

## Design: three zero-argument entrypoints

The reason this contract exists at all is that a session key can be scoped to a
`(target, selector)` pair but **not** to call arguments. Scoping an agent
directly to Aave's `withdraw(asset, amount, to)` or to ERC-20 `transfer(to,
amount)` would leave `to` under the attacker's control, which is a drain with
extra steps.

The router removes the argument surface. It exposes exactly three selectors,
each taking nothing at all (`packages/shared/src/contracts.ts`, `ROUTER_ACTIONS`):

| Signature | Selector | Effect |
| --- | --- | --- |
| `toAave()` | `0xdb1a4d6d` | Collect idle stablecoin and any safe Venus source leg, then supply to Aave; an existing Aave target leg is untouched |
| `toVenus()` | `0x88b480df` | Collect idle stablecoin and any safe Aave source leg, then mint Venus receipts; an existing Venus target leg is untouched |
| `toIdle()` | `0x18b5e866` | Return idle stablecoin and unwind each debt-free source leg; encumbered collateral remains where it is |

Every recipient in the contract is `msg.sender`, hardcoded. There is no calldata
that names a destination, because there is no calldata. The account that calls
is the account that receives, in all three paths and in the private
`_collectUsdt` helper they share.

Supporting properties, all readable in the source: no owner, no admin role, no
upgrade path, no `selfdestruct`, no `delegatecall`, a `nonReentrant` guard on
each entrypoint, and exact allowances set through `_approve` (reset to zero,
then to the amount, with both return values checked, because BSC USDT is a
bool-returning non-standard token).

So a stolen session key can shuffle the user's funds between the user's own
positions, or return them idle to the user. It cannot name a third party. The
debt guards described below also prevent it from removing collateral while a
venue reports an outstanding borrow.

## Delta accounting (audit finding L-1)

The first deployment (`0x841CF14D…b260`, superseded) distributed the router's
**whole** balance at the end of a call. Since anyone can send tokens to any
address, a stray or donated balance sitting in the router would have been paid
out to whoever called next, including a caller who had deposited nothing.

The fix is delta accounting. `_collectUsdt` snapshots the router's stablecoin
balance on entry, pulls only the caller's own positions in, and returns the
difference:

```solidity
uint256 entryUsdt = USDT.balanceOf(address(this));
// ... pull the caller's vTokens, aTokens, idle USDT, each FROM the account ...
return USDT.balanceOf(address(this)) - entryUsdt;
```

The Venus path does the same for vTokens: it snapshots before `mint` and hands
back only `balanceOf(this) - preMint`, so a stray vToken balance cannot ride
along. The Aave path withdraws exactly the caller's aToken balance rather than
`type(uint256).max`, for the same reason.

Three fork tests in
[`contracts/test/AgripinaaYieldRouter.t.sol`](../contracts/test/AgripinaaYieldRouter.t.sol)
pin this behaviour:

- `test_attackerCannotSweepStrayUsdt`
- `test_strayUsdtIsNotDistributedToUser`
- `test_strayVusdtIsNotHandedToUser`

## Two invariants, and the harness that hunts them

[`contracts/test/fuzz/RouterFuzz.sol`](../contracts/test/fuzz/RouterFuzz.sol)
drives deposits, rotations, withdrawals and out-of-band donations across three
independent actors, against mocks of BSC USDT (bool-returning ERC-20), Aave V3
(`onBehalfOf` mint, max-withdraw) and Venus (Compound-v2 fork: error codes on
`mint`/`redeem`, mint credits the caller). The venues are 1:1, which is what
lets the two properties be strict:

- `echidna_no_actor_exceeds_deposits`: no actor can ever hold more value than
  they deposited. An attacker with zero deposits ends at zero; nobody sweeps
  another actor's principal or a donation. This is L-1 as an executable
  property.
- `echidna_router_holds_only_donations`: the router never custodies more than
  what was donated to it, so the "ends every call at a zero balance" claim is a
  bound rather than a comment.

Both engines run the same harness against the same prefix:

```bash
cd contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
echidna test/fuzz/RouterFuzz.sol --contract RouterFuzz --config echidna.yaml
medusa fuzz                                 # reads medusa.json
```

(`contracts/lib` is gitignored, so forge-std is fetched rather than vendored.)

`contracts/echidna.yaml` is property mode, `testLimit: 60000`, `seqLen: 60`.
`contracts/medusa.json` targets `RouterFuzz` with the same 60,000-case limit,
call sequences of 60, six workers, and `testPrefixes: ["echidna_"]`.

The harness now exercises Aave aggregate debt, ordinary Venus market debt and
Venus VAI debt, and asserts that guarded receipt legs stay untouched while an
independent idle leg can complete. It still has an economic-model blind spot:
the mocks have no oracle, collateral-factor changes, health factor or
liquidation engine. Fork tests and manual protocol review cover the ledger
bindings; neither fuzzer proves lending-market solvency.

## Twenty fork tests against live BSC venues

`contracts/test/AgripinaaYieldRouter.t.sol` forks BSC mainnet (`forge test
--fork-url bsc`, or plain `forge test` using the `[rpc_endpoints]` alias in
`contracts/foundry.toml`) and runs against the actual Aave V3 pool and Venus
vToken, not mocks:

| Test | What it establishes |
| --- | --- |
| `test_toAave_movesUsdtIntoUserAavePosition` | aTokens land in the user's account, router ends empty |
| `test_toVenus_movesUsdtIntoUserVenusPosition` | vTokens are handed back to the user, router ends empty |
| `test_rotationRoundTripReturnsPrincipal` | Aave to Venus to idle returns the principal, within redemption dust |
| `test_attackerCannotTouchAnotherUsersFunds` | An attacker hammering every entrypoint reaches only their own empty balances |
| `test_idleOnEmptyAccountIsNoOp` | No entrypoint takes a recipient, so an empty caller moves nothing |
| `test_idleOnlyToIdleIsNoOpAndEmitsNoRotated` | Returning already-idle funds does not manufacture activity telemetry |
| `test_sameTargetOnlyCallsAreNoOps` | Calling the already-held target neither round-trips receipts nor emits a rotation |
| `test_attackerCannotSweepStrayUsdt` | Stray USDT cannot be swept by a zero-balance caller |
| `test_strayUsdtIsNotDistributedToUser` | A legitimate user gets exactly their principal, the stray stays stranded |
| `test_strayVusdtIsNotHandedToUser` | The vToken hand-back returns only this call's mint |
| `test_usdc_rotationRoundTripReturnsPrincipal` | Same bytecode, USDC venues, round trip holds |
| `test_usdc_attackerCannotTouchAnotherUsersFunds` | Same bytecode, USDC venues, isolation holds |
| `test_aaveDebtLeavesCollateralUntouchedAndProcessesIdle` | Aave debt protects the aToken leg while independent idle funds still complete |
| `test_venusDebtLeavesCollateralUntouchedAndProcessesIdle` | Ordinary Venus debt protects the vToken leg while independent idle funds still complete |
| `test_venusVaiDebtLeavesCollateralUntouchedAndProcessesIdle` | The separate VAI ledger protects the Venus receipt leg |
| `test_venusComptrollerMigrationFailsClosed` | A governance migration of the vToken to another Comptroller cannot bypass the cached VAI/debt ledger |
| `test_toVenusDoesNotInspectTargetVenusDebt` | A target-only Venus position is not needlessly pulled through the router |
| `test_donatedAaveReceiptCannotBlockIdleWithdrawal` | A one-unit receipt donation cannot globally deny service to idle funds |
| `test_venusDustMintRevertsInsteadOfBurningUnderlying` | A zero-share Venus mint cannot consume underlying silently |
| `test_constructorRejectsInvalidOrMismatchedDependencies` | Zero/non-contract dependencies and receipt tokens for another underlying are rejected |

## Session scoping is fail-closed

A perfect contract behind a sloppy grant is still a drain. The upstream defaults
are dangerous in two specific ways: omitting `permissions.calls` authorizes
**every** contract, and a spend entry with no token address caps the **native**
token instead of the stablecoin. `packages/session-kit/src/scope.ts` exists to
make both unreachable, and `packages/session-kit/tests/scope.test.ts` pins each
rule:

| Rule | Test |
| --- | --- |
| No allowlist and no call scopes is refused, never widened | `missing allowlist throws` |
| An empty allowlist is refused | `empty allowlist throws (fail-closed against upstream unrestricted default)` |
| An empty signature list is refused, because it would widen to every selector | `empty signatures list throws (would widen to every selector)` |
| A bare selector or function name is refused; only a full signature scopes | `a bare selector or function name (not a signature) throws` |
| Porto's `anyTarget` and `selfAddress` sentinels are refused | `allowlist with Porto anyTarget wildcard throws`, `allowlist with Porto selfAddress sentinel throws`, `callScopes targeting the anyTarget wildcard throws` |
| One wildcard entry rejects the whole grant, not just that entry | `a mixed allowlist with one wildcard entry is rejected wholesale` |
| The spend cap carries the token address, so it caps USDT and not BNB | `spend entry carries the token address (a token-less cap would cap native BNB)` |
| 18-decimal BSC USDT, not 6 | `"50" USDT cap converts to 50n * 10n**18n (18 decimals on BNB)` |
| Expiry is bounded to 30 days and must be a positive integer | `expiry beyond 30 days throws`, `zero expiry throws`, `negative expiry throws`, `non-integer expiry throws` |
| Mixing an allowlist with call scopes is refused rather than merged | `providing both allowlist and callScopes throws` |

One rule in `scope.ts` carries no test of its own: `no-wildcard-selector`
refuses a signature whose 4-byte selector collides with Porto's `anySelector`.
Writing such a signature by accident is not a reachable case, so it is stated
here as code, not as coverage.

The managed grant itself is built in `apps/web/src/lib/managed.ts`
(`buildManagedScope`): call scopes limited to the three router signatures on the
one router deployment for that token, one canonical daily cap on the managed token, a tight
native gas allowance (0.005 BNB per day, enough for a few rotations and not
much else), and an explicit expiry. Sessions are persisted byte-exactly
(`packages/session-kit/src/persist.ts`, tests in
`packages/session-kit/tests/persist.test.ts`) because the relay validates
against the exact granted object, and validity is read back from the KeyStore
registry (`packages/session-kit/src/verify.ts`, `packages/session-kit/tests/verify.test.ts`)
so revocation shows up on `/dashboard` rather than being assumed. Mainnet
authority reads require two of three independent RPC providers to agree. The
runner also quorum-checks the smart account's own key descriptor and its
enumerable call, spend, call-checker, and signature-checker maps. It requires
the canonical secp256k1 manager identity, exact expiry, exact selector/cap
shape, and no local or global authority extensions; public KeyStore facts
therefore cannot be combined with invented session bytes to overwrite a
working mandate.

## The key the session is granted to

The runner base is a rotating quick-tunnel hostname, so the point where a
hijacked base could become a session grantee is the manager key the browser
reads back from it. `apps/web/src/lib/manager-key.ts` refuses anything that
fails three checks: the public key is a 65-byte SEC1 point, the reported address
is the one that public key derives to, and where the shared registry pins an
address for that agent and token, the report matches the pin. Tests in
`apps/web/tests/manager-key.test.ts`: `the pinned Harvester key is accepted`, `a
well-formed key that is not the pinned one is refused (mocked runner)`, `the
pinned address with a foreign public key is refused`, `malformed fields are
refused before any pin check`.

On the runner side, the manager key is derived per token and the executor
refuses to sign with a key that does not match the granted session
(`apps/agents/tests/managed.test.ts`: `deriveManagerKey: distinct on-chain
identity per token, deterministic`, `managedExecutor refuses a debt-incomplete
router even when its manager key matches`, `token-driven selection also refuses
the debt-incomplete USDC deployment`). Managed state files are written 0600
inside a 0700 data directory (`the managed registry file lands at 0600 inside a
data dir tightened to 0700`).

## What the audit found

A dedicated Solidity audit pass ran over the live BSC deployments on
2026-08-24, one of five review lenses turned on the project that day. No High
and no Critical findings. The pass, its scope and its result are written down in
the plan, under the heading "Verification sweep, 2026-08-24 (five independent
lenses)" and its "Router audit" paragraph
([`docs/superpowers/plans/2026-08-24-marketplace-expansion.md`](./superpowers/plans/2026-08-24-marketplace-expansion.md)).

The L-1 delta-accounting fix was checked rather than assumed. Claim by claim,
with where each one can be checked from this repo and where it cannot:

- **The replacement deployments' constructor bindings and receipts were
  independently verified on 2026-08-26.** Their creation transactions and
  exact blocks are pinned in `packages/shared/src/contracts.ts`; their USDT,
  aToken, Aave pool, and vToken getters match that registry.
- **The twenty fork tests passed.** Each is named under "Twenty fork tests against
  live BSC venues" above, in
  [`contracts/test/AgripinaaYieldRouter.t.sol`](../contracts/test/AgripinaaYieldRouter.t.sol),
  and `forge test --fork-url bsc` runs them against the live venues.
- **Echidna and Medusa each completed 60,000-case campaigns with both
  properties holding.** The properties are `echidna_no_actor_exceeds_deposits`
  and `echidna_router_holds_only_donations` in
  [`contracts/test/fuzz/RouterFuzz.sol`](../contracts/test/fuzz/RouterFuzz.sol);
  the 60,000-case limit is in `contracts/echidna.yaml` and
  `contracts/medusa.json`. The campaign logs are not committed, so re-running
  the two engines is the check.
- **30-day fork simulations showed yield reaching the user while donated aTokens
  and vTokens stayed untouched.** Run by the audit on 2026-08-24. No simulation
  script and no output from it are committed here, so this figure is reported
  rather than reproducible from this repo.

## The Medium is fixed in source and version 3 is deployed

The 2026-08-25 audit found one Medium issue (confidence 90), with a working
proof of concept. Stated in full, precondition included:

> `_unwindAllToUsdt` can strip a receipt token that secures live venue debt for
> an account that also borrowed in the same venue, and no managed account
> carries venue debt today.

The mechanism: unwinding pulls the user's aToken or vToken out of the venue to
rotate it. If that receipt token is also posted as collateral against a
borrow **in the same venue**, the forced rotation removes the collateral while
the debt stays, and a barely solvent account can be pushed toward liquidation.
The PoC used $1,000 aUSDT plus $2,000 WBNB against $1,390 USDC debt:
health factor 1.4784 to 1.0792 on the forced rotation, to 0.9173 after a 15
percent WBNB move, attacker profit about $125. Those figures come from the
audit's proof of concept, run on 2026-08-24, and the PoC itself is not
committed here, so they are reported rather than re-runnable from this repo.

Three things follow, and none of them are softened here:

1. **The precondition is load-bearing.** The claim "a compromised session key
   cannot cost this user value" holds only for an account with no debt in the
   venue its receipt token sits in. It is not a property of the contract in
   general.
2. **Checked on-chain, not assumed:** read back on 2026-08-24, the single live
   managed account has zero debt in both venues and has entered no Venus market
   as collateral, so no user is exposed. No transcript of that read is
   committed, and it is a fact about accounts rather than about the code, so it
   expires: re-read it before adding another mandate, with Aave's
   `getUserAccountData` and the Venus comptroller's `getAssetsIn` and
   `getAccountLiquidity` (the same reads `apps/agents/src/agents/health-factor.ts`
   and `apps/agents/src/agents/venus-guardian.ts` use) against the managed
   account.
3. **The original fuzz harness could never have found this.** Its mocks had no
   debt or collateral state. The current harness adds the relevant debt ledgers
   and guarded-leg assertions, while retaining the economic-model limitation
   described above.

The source now implements the structural fix: it refuses an Aave unwind when
`getUserAccountData` reports debt and refuses a Venus unwind when any entered
market reports a borrow, including Venus's separate `mintedVAIs` ledger.
Encumbered source legs are left untouched instead of reverting unrelated safe
funds, and constructor checks bind the comptroller and receipt tokens to their
configured dependencies. The fork suite proves these paths.

The version-3 deployments at the top of this document check Aave aggregate
debt, ordinary entered Venus-market borrows, and VAI. Their creation
transactions are
`0xd6501a3deeaf406a50b58bd44383c8d51e9e00ea5f3565a25d15ba6d6fbcd0f8`
(USDT) and
`0x1bb52e4a17ba05292a4fa208ecc7b13efc01a30ecec8363404d421ed9413f0e7`
(USDC). The shared registry marks only version 3 with a matching pinned runtime
hash as executable; the web activation path, owner unwind path and runner all
fail closed on older deployments or a live-code mismatch.

The superseded version-2 addresses `0xE69503b2…3C02` (USDT) and
`0x0DD7B744…6167` (USDC), plus the earlier version-1 addresses, remain in the
recovery registry. A prior session cannot authorize a replacement address: an
owner who wants managed execution through version 3 must approve the new
router and grant a fresh mandate. Old scopes remain recovery-only.

## Reproduce it

```bash
cd contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge test --fork-url bsc                                   # the twenty fork tests
echidna test/fuzz/RouterFuzz.sol --contract RouterFuzz --config echidna.yaml
medusa fuzz

cd ..
pnpm --filter @agripinaa/session-kit test                    # the scoping rules
pnpm --filter @agripinaa/web test                            # manager-key pin checks
pnpm --filter @agripinaa/agents test                         # executor key binding
```

Compare the deployed bytecode against the compiled artifact with
`cast code <router address> --rpc-url https://bsc-rpc.publicnode.com`, or read
the two deployments, their venue addresses, and their rotation history on
[`/funds`](https://agripinaa.vercel.app/funds).
