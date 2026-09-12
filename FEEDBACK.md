# Uniswap Foundation: developer feedback (ETHOnline 2026)

Project: Agripinaa, an ERC-8004 agent marketplace on BNB Smart Chain.
Contribution: the Ranger agent (Pancake V3 range management, rebalanced
through Ophis batch auctions) now runs on **Uniswap v3 on BNB Smart Chain** as
a selectable venue. Where to look:

- `apps/agents/src/lp-venues.ts`: the venue table. Uniswap v3 BNB addresses
  from developers.uniswap.org, each probed on-chain before use, with the probe
  record in the comment above the entry.
- `apps/agents/src/agents/lp-range.ts`: the strategy. `VENUE = selectLpVenue()`
  replaces the hardcoded Pancake constants; every mint, decreaseLiquidity,
  collect, factory `getPool` and pool read goes through the venue record.
- `apps/agents/tests/lp-venues.test.ts`: selection, the slot0 width per venue,
  and the published addresses.
- `ops/launch.md`: `LP_RANGE_VENUE=uniswap-v3` switches the agent's own
  capital; managed mandates keep their audited PancakeSwap session policy.

## What we used

- NonfungiblePositionManager `0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613`
- UniswapV3Factory `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7`
- WBNB/USDT pools at 100, 500, 3000 and 10000; the agent selects the deepest at
  runtime through the factory rather than hardcoding a pool.

Probe, 2026-09-12, viem readContract on https://bsc-rpc.publicnode.com at
block 121491250: `factory()` and `WETH9()` on the manager match the published
factory and WBNB; the four pools report liquidity 1.35e23, 1.14e24, 3.50e22
and 1.81e22, token0 USDT in all four, `slot0().feeProtocol` 68 and 102.

## Feedback

1. **The deployments page moved and the old URL chains two redirects.**
   `docs.uniswap.org/contracts/v3/reference/deployments/bnb-deployments`
   answers 301 to `developers.uniswap.org/contracts/...`, which answers 303 to
   an `llms.mdx` path. A fetcher that refuses cross-host redirects (ours does,
   for SSRF reasons) gets nothing. One stable JSON of deployments per chain,
   linked from the page, would let a build pin addresses without scraping.

2. **The published table does not say which fee tiers a pair exists at.**
   We had to probe `getPool` for every tier. A per-chain list of the deepest
   pools per pair, even a daily snapshot, would save every integrator the same
   four calls and, more importantly, would let them notice when the deepest
   pool moves (the price a range strategy protects itself against is read from
   that pool).

3. **`slot0` is the one ABI difference between Uniswap v3 and its forks that
   bites silently.** `feeProtocol` is `uint8` on Uniswap and `uint32` on
   PancakeSwap. Decoding with the wrong width does not throw; it shifts the
   trailing `unlocked` boolean. The v3 docs could carry a one-line "forks
   differ here" note next to the `slot0` reference; we now carry one ABI per
   venue for exactly this reason.

4. **What worked.** The periphery being byte-compatible across the fork meant
   the whole venue switch is one record and no strategy change: the same
   `mint`, `decreaseLiquidity` and `collect` tuples, the same `getPool`, the
   same `observe` for the TWAP guard. The Universal Router and Permit2 being
   at canonical addresses on BNB was reassuring for the next step (paying
   through Permit2 from a session-scoped account).

5. **A request.** Ophis batch auctions do the rebalancing swap for this
   strategy so the agent never crosses a pool at spot. A documented way to
   express "a v4 hook that only accepts fills from a batch settlement
   contract" would let the two compose: the range lives on Uniswap, the
   rebalance clears MEV-protected. We would build that hook for a v4 BNB
   deployment.
