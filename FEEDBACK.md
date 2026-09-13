# Uniswap Foundation: developer feedback (ETHOnline 2026)

Project: Agripinaa, an ERC-8004 agent marketplace on BNB Smart Chain.
Contribution: the Ranger agent (Pancake V3 range management, rebalanced
through Ophis batch auctions) now runs on **Uniswap v3 on BNB Smart Chain** as
a selectable venue. Where to look:

- `apps/agents/src/lp-venues.ts`: the venue table. Uniswap v3 BNB addresses
  from developers.uniswap.org, each probed on-chain before use, with the probe
  record in the comment above the entry.
- `apps/agents/src/agents/lp-range.ts`: the strategy. `venueContext()` binds
  each run to a venue record; every mint, decreaseLiquidity, collect, factory
  `getPool` and pool read goes through `ctx.venue`.
- `apps/agents/tests/lp-venues.test.ts`, `lp-range-venue.test.ts`,
  `lp-range-venue-config.test.ts`: selection, the shared pool ABI, the
  own-capital versus managed binding, and a misnamed venue stopping Ranger
  alone.
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

## Live on mainnet

Switched on 2026-09-13 00:45 UTC with `LP_RANGE_VENUE=uniswap-v3` on the
production runner. Ranger's first tick on the new venue, from its JSONL log:

- `pool-selected`: `0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869`, fee 500,
  the deepest WBNB/USDT pool at that moment (liquidity 1.65e24).
- `inventory-prep`: sold 0.00152 WBNB for USDT through an Ophis batch
  auction, order `0xf3f261b5…a5f94b`, filled 15 seconds later.
- `minted`: Uniswap v3 position **2745250**, ticks -66390 to -65410 around
  the current tick -65897, transaction
  `0x3dffa2c5dc47ebbfea32fef0fecb628b2aca991877025285a5cda285e4c15076`,
  owned by Ranger's wallet `0x79827EF1faDeA3B30A8E77fdbaF17944298A3bB6`.

Forty seconds from restart to a live position, no code change between the
PancakeSwap and Uniswap runs. The four records, verbatim from the runner's
journal (`apps/agents/data/lp-range.log.jsonl` on the VM):

```json
{"at":"2026-09-13T00:45:53.093Z","agent":"lp-range","event":"pool-selected","pool":"0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869","fee":500,"tickSpacing":10,"wbnbIsToken0":false,"liquidity":"1650088509849585424835459"}
{"at":"2026-09-13T00:45:59.087Z","agent":"lp-range","event":"ophis-swap-submitted","orderUid":"0xf3f261b567602f5aafe7d69a68229df9ca55a5874e540ac4c5bc525802bd730f79827ef1fadea3b30a8e77fdbaf17944298a3bb66aa5f94b","explorerUrl":"https://explorer.ophis.fi/orders/0xf3f261b567602f5aafe7d69a68229df9ca55a5874e540ac4c5bc525802bd730f79827ef1fadea3b30a8e77fdbaf17944298a3bb66aa5f94b","sellToken":"WBNB","buyToken":"USDT","sellAmount":"0.001522369437","notionalUsd":1.107201516766753,"minBuyAmount":"1091786132287050670","enrollmentWarning":null}
{"at":"2026-09-13T00:46:14.410Z","agent":"lp-range","event":"ophis-order-filled","orderUid":"0xf3f261b567602f5aafe7d69a68229df9ca55a5874e540ac4c5bc525802bd730f79827ef1fadea3b30a8e77fdbaf17944298a3bb66aa5f94b"}
{"at":"2026-09-13T00:46:26.877Z","agent":"lp-range","event":"minted","txHash":"0x3dffa2c5dc47ebbfea32fef0fecb628b2aca991877025285a5cda285e4c15076","tokenId":"2745250","tickLower":-66390,"tickUpper":-65410,"currentTick":-65897,"wbnbUnits":0.001477630563,"usdtUnits":1.1192367490982553}
```

The `inventory-prep` decision that preceded the swap, for completeness:

```json
{"at":"2026-09-13T00:45:53.492Z","agent":"lp-range","event":"inventory-prep","sell":"WBNB","amountUnits":0.0015223694372417749,"notionalUsd":1.107201516766753,"wbnbUnits":0.003,"usdtUnits":0.012919603784337786,"usdtPerWbnb":727.2883241618263}
```

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

3. **`slot0` reads the same on Uniswap v3 and its forks, and we first
   thought it did not.** PancakeSwap declares `feeProtocol` as `uint32`,
   Uniswap as `uint8`. Our first venue record carried one pool ABI per venue
   on the belief that decoding with the wrong width would shift the trailing
   `unlocked` boolean. It does not: ABI static types are word-padded, so the
   seven return words decode identically under either declaration, which we
   verified by encoding a PancakeSwap-shaped `slot0` and decoding it with the
   Uniswap ABI. One ABI now serves both. The docs could still say this in one
   line next to `slot0`, because an integrator reading two verified sources
   with different widths will reach for the same wrong conclusion we did.

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
