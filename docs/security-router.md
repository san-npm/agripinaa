# Router security

Managed yield is the only Agripinaa feature that touches a user's own capital.
It works by granting an agent a session key on the user's smart account, scoped
to one contract: `AgripinaaYieldRouter`
([`contracts/src/AgripinaaYieldRouter.sol`](../contracts/src/AgripinaaYieldRouter.sol)).
This document states what that session key can do if it is stolen outright, and
cites the file, the test, or the address behind each claim so a reviewer can
check it rather than take it.

Deployed and in use on BNB Smart Chain (`packages/shared/src/contracts.ts`):

| Managed token | Address | Deployed |
| --- | --- | --- |
| USDT | `0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb` | 2026-08-20 |
| USDC | `0xb0817946B5A30A0A2a3dE1B8202749EBEb664630` | 2026-08-21 |

Balances under management and every rotation on record are public at
[`/funds`](https://agripinaa.vercel.app/funds).

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
| `toAave()` | `0xdb1a4d6d` | Unwind everything the caller holds, supply it to Aave, aTokens minted to the caller |
| `toVenus()` | `0x88b480df` | Unwind everything the caller holds, mint vTokens, hand exactly this call's mint to the caller |
| `toIdle()` | `0x18b5e866` | Unwind everything the caller holds back to the caller's plain USDT |

Every recipient in the contract is `msg.sender`, hardcoded. There is no calldata
that names a destination, because there is no calldata. The account that calls
is the account that receives, in all three paths and in the private
`_unwindAllToUsdt` helper they share.

Supporting properties, all readable in the source: no owner, no admin role, no
upgrade path, no `selfdestruct`, no `delegatecall`, a `nonReentrant` guard on
each entrypoint, and exact allowances set through `_approve` (reset to zero,
then to the amount, with both return values checked, because BSC USDT is a
bool-returning non-standard token).

So a stolen session key can shuffle the user's funds between the user's own
positions, or return them idle to the user. It cannot name a third party. The
one exception is the open Medium below, and it has a precondition.

## Delta accounting (audit finding L-1)

The first deployment (`0x841CF14D…b260`, superseded) distributed the router's
**whole** balance at the end of a call. Since anyone can send tokens to any
address, a stray or donated balance sitting in the router would have been paid
out to whoever called next, including a caller who had deposited nothing.

The fix is delta accounting. `_unwindAllToUsdt` snapshots the router's USDT
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

The harness has a known blind spot, and it is the one that matters below: its
mocks have no collateral flags, no debt, no oracle, no health factor and no
liquidation. It can prove nothing about an account that borrows.

## Ten fork tests against live BSC venues

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
| `test_attackerCannotSweepStrayUsdt` | Stray USDT cannot be swept by a zero-balance caller |
| `test_strayUsdtIsNotDistributedToUser` | A legitimate user gets exactly their principal, the stray stays stranded |
| `test_strayVusdtIsNotHandedToUser` | The vToken hand-back returns only this call's mint |
| `test_usdc_rotationRoundTripReturnsPrincipal` | Same bytecode, USDC venues, round trip holds |
| `test_usdc_attackerCannotTouchAnotherUsersFunds` | Same bytecode, USDC venues, isolation holds |

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
one router deployment for that token, a daily cap on the managed token, a tight
native gas allowance (0.005 BNB per day, enough for a few rotations and not
much else), and an explicit expiry. Sessions are persisted byte-exactly
(`packages/session-kit/src/persist.ts`, tests in
`packages/session-kit/tests/persist.test.ts`) because the relay validates
against the exact granted object, and validity is read back from the KeyStore
registry (`packages/session-kit/src/verify.ts`, `packages/session-kit/tests/verify.test.ts`)
so revocation shows up on `/dashboard` rather than being assumed.

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
identity per token, deterministic`, `managedExecutor rejects a manager key that
does not match the granted session`, `token-driven selection rejects a USDC
entry that was granted to the USDT key`). Managed state files are written 0600
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

- **Both deployments' runtime bytecode matched the compiled source.** Re-run
  that comparison with `cast code` against a local `forge build` artifact, using
  the two addresses in the table at the top of this document. The audit's own
  comparison output is not committed.
- **The ten fork tests passed.** Each is named under "Ten fork tests against
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

## The open Medium, with its precondition

One Medium finding (confidence 90) stands open, with a working proof of
concept. Stated in full, precondition included:

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
3. **The fuzz harness could never have found this.** Its mocks have no debt, no
   collateral flags, no oracle and no liquidation, which is exactly why the
   blind spot is written down above rather than left to be discovered.

The cheap mitigation is refusing activation for an account that carries venue
debt. The structural fix is a guarded redeploy, and it is the owner's call: the
routers are immutable, so a redeploy means new addresses, fresh approvals, and
migrating the live mandate.

## Reproduce it

```bash
cd contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge test --fork-url bsc                                   # the ten fork tests
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
