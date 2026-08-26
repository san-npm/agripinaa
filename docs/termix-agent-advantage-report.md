# Agent Advantage Report

Submission for the TermiX partner track of BNB Chain's "Build the Era"
hackathon. Three tasks executed both ways, manually and through an Agripinaa
reference agent, with time, cost, and output quality measured and the actual
outputs attached. Everything below happened on BSC mainnet, with the project's
own capital except where a managed user account is named.

First written 2026-08-18. Refreshed 2026-08-25 against a week of live
settlement and on-chain data: every figure here was re-read from the CoW
orderbook serving BNB Chain or from BSC mainnet state at block **118027877**
(2026-08-25T15:58:34Z) unless a different block or timestamp is named on the
line. The raw pull is attached as `evidence/2026-08-25-refresh.json`, and it
carries the full order uids the tables below abbreviate.

## How to read the price figures

Two different measures of a fill appear below, and they are not
interchangeable. A third convention governs every dollar figure in the document.

- **Surplus vs the signed limit.** What the wallet received over the buy amount
  it signed for, computed by `surplusBps` in `@agripinaa/exec-metrics`. This is
  the number the marketplace and the receipts print.
- **Price vs the quote at signing.** The same fill with the slippage tolerance
  taken back out. `@ophis/agent-swap` signs `buyAmount = quote × (1 -
  slippageBps/10000)`, so `vsQuote = (1 - slippageBps/10000) × (1 +
  surplus/10000) - 1`. The Grid and the Ranger sign at 100 bps of tolerance
  (`SLIPPAGE_BPS` in `apps/agents/src/agents/grid.ts` and the `slippageBps: 100`
  in `lp-range.ts`); the 2026-08-18 order in Task 1 was signed at 50 bps
  (`packages/spikes/scripts/spike-a.ts`).
- **Dollars.** BNB moved 16.8% across the week the agents traded, so no amount
  here is priced at a single spot rate. That figure is the spread of the rates
  our own fills executed at, 611.4443 to 714.0883 USDT per WBNB between 08-19
  and 08-25, and it is 18.4% counting the 2026-08-18 fill at 602.8648. Anything
  a fill produced (its notional, its surplus, its fee) is valued at that fill's
  own executed USDT/WBNB rate, with the rate applied to the leg denominated in
  WBNB and a leg already denominated in USDT taken at 1 USDT = 1 USD. Anything
  else denominated in BNB (gas) names the rate it uses and where that rate comes
  from, on the line itself. Each fill's rate is in the attached pull under
  `derived.executedUsdtPerWbnb`, alongside the dollar amounts derived from it.

The two price measures are stated for every fill. A settlement that beats the
signed limit can still land below the quote it was signed against, and two of
the eight fills below did.

## Task 1: Execute a WBNB → USDT swap (trading task)

**Manual baseline (executed 2026-08-18, `evidence/task1-baseline.json`).**
A direct PancakeSwap V3 router swap: single pool, no auction, the standard
manual path once a person has already found the pool and prepared the wallet.
Sent from wallet `0x053fff26d28ff4e94dfe862b184f918a50c6f706`.

- Executed 0.0008 WBNB into 0.482844230664355319 USDT (603.5553 USDT per WBNB),
  fee tier 100, at block 116705948 (2026-08-18T18:40:49Z).
- Cost: two transactions from the wallet, 28,940 gas on the ERC-20 approval plus
  146,806 on the swap, 175,746 units at 0.05 gwei, so 0.0000087873 BNB, about
  $0.0053 at this swap's own executed rate of 603.5553. Split out, because the
  agent comparison below has to count the same items on both sides: the swap leg
  is 0.0000073403 BNB, about $0.0044, and the approval is 0.000001447 BNB, about
  $0.0009. That approval covers only the exact amount being sold
  (`apps/agents/src/baseline-swap.ts` approves `amountIn`), so it recurs with
  every swap rather than being a one-time setup cost. Both receipts re-read
  on-chain for this refresh.
- Time: 2.021 s of transaction latency. A person driving a wallet UI adds
  minutes of attention on top of that, every single time.
- Output quality: two transaction hashes (approve
  `0x6b8a369b955a09bbdb155cb3e2478a7e4afef716f0fb27ddc6fc5feca7517dec`, swap
  `0xa72d0e47e172d490396303b953b5369942e7be1f200f17abba6d9e3b806f40d4`). By
  construction the AMM path pays pool price minus the LP fee: price improvement
  is not available at all, exposure to the mempool is bounded only by a
  slippage number the user picks, and there is no execution artifact beyond the
  raw transaction.

**Agent path, same wallet, same day (submitted 2026-08-18T16:24:37Z, settled
16:24:45Z).** The Ophis batch auction path the agents use: sign an intent
off-chain, a solver competes for it and settles it.

- Order uid
  `0xa2fa52fa97922df8b884345a2959a71209a73957073098c4af76cbd72fa1f02b053fff26d28ff4e94dfe862b184f918a50c6f7066a848e4c`,
  0.02 WBNB into 12.057295806540799277 USDT.
- +48.61 bps over the signed limit (+0.058332742861982384 USDT), which at the
  50 bps tolerance it was signed with is 1.63 bps **below** the quote at
  signing. Stated plainly because the first draft of this report cited only the
  first of those two numbers. The attached receipt carries this same fill as
  `surplusVsQuote: 0.00486148199243626`, which despite the field name divides by
  the receipt's own `buyAmount`, the signed limit with the 50 bps tolerance
  already taken out of the quote: the +48.61 bps and the 1.63 bps below the quote
  are two baselines, not two readings of one (owner review note 7).
- Settled 7.2 s after submission, in tx
  `0x4c7b847b75ae82337ac28655db861a5cd512e0de77c820f64dc58bbaa50523d1`
  (block 116687812) submitted by solver `0x95480d3f…`. The wallet paid no BNB on
  the settlement: the winning solver submits and pays for it. It did pay gas on
  its own ERC-20 approval beforehand, the same item the baseline's $0.0009
  approval covers on the manual side, which is why the cost comparison below
  leaves the approval out of both sides.
- Fee: 0.000043920324779203 WBNB taken inside the settlement, 21.96 bps of the
  amount sold, about $0.0265 at this fill's own executed rate of 602.8648 USDT
  per WBNB. The surplus figure above is already net of it.
- Output quality: a downloadable receipt JSON (attached,
  `evidence/task1-receipt.json`) carrying executed against signed amounts, the
  settlement transaction and block, and the partner-fee disclosure.

**What the agents have executed since (the week of 2026-08-19 to 2026-08-25).**
This is the part the first draft could not show. Seven further fills, all
through Ophis, all from agent wallets with no human in the loop, all fulfilled.

| Submitted (UTC) | Agent | Sold | Surplus vs limit | vs quote | Settled in | Settlement |
| --- | --- | --- | --- | --- | --- | --- |
| 08-19 15:15 | Grid | 0.00326503 WBNB | +122.65 bps | +21.42 bps | 8.4 s | [`0x666b21c8`](https://bscscan.com/tx/0x666b21c8a82a496a7a88c829618c8e37bb36d06f5bc38ebbd594e2a739d21dd4) |
| 08-20 08:41 | Ranger | 1.249640 USDT | +152.67 bps | +51.14 bps | 8.3 s | [`0xd6a407f2`](https://bscscan.com/tx/0xd6a407f217011f9af360b9c252406e0b203e983117907857dcca67c6a6bd53c8) |
| 08-21 08:42 | Ranger | 1.573712 USDT | +150.62 bps | +49.11 bps | 8.3 s | [`0xb306e1b7`](https://bscscan.com/tx/0xb306e1b7de4fae456ce313037974ed2a4e89935d644091c534061b3a58d1216b) |
| 08-22 05:11 | Grid | 2.000000 USDT | +75.23 bps | -25.52 bps | 168.9 s | [`0x9e914a0b`](https://bscscan.com/tx/0x9e914a0b6473b1f853813b5e3730e20f51672dbace4ce71adc76287f60a24099) |
| 08-24 15:41 | Ranger | 1.597934 USDT | +117.13 bps | +15.96 bps | 10.6 s | [`0x509f1117`](https://bscscan.com/tx/0x509f1117e07ccb45184785cfe558b4c89cb3c6b6317bd791d45926948b5d6cad) |
| 08-24 15:45 | Grid | 1.996384 USDT | +118.15 bps | +16.97 bps | 12.5 s | [`0x68642b06`](https://bscscan.com/tx/0x68642b06dac85d650c2c496681c376f84dbba442b2fedf22cc885a0e8170d7a5) |
| 08-25 10:02 | Grid | 1.500000 USDT | +124.44 bps | +23.20 bps | 12.3 s | [`0x98962f41`](https://bscscan.com/tx/0x98962f41230e756c5fa58f0d1e56e4918703b769aab37ad060552f35d1f67ea2) |

- Grid (ERC-8004 token 269703, wallet `0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A`):
  4 fills, mean +110.12 bps over the signed limit, mean +9.02 bps over the quote,
  cumulative surplus 0.024190818740329959 USDT plus 0.000080291902987458 WBNB.
- Ranger (token 269706, wallet `0x79827EF1faDeA3B30A8E77fdbaF17944298A3bB6`):
  3 fills, mean +140.14 bps over the signed limit, mean +38.74 bps over the
  quote, cumulative surplus 0.000089699201752126 WBNB.
- Across the seven agent fills: mean +21.75 bps against the quote, worst
  -25.52 bps, best +51.14 bps. Cumulative surplus over the signed limits is
  0.024190818740329959 USDT plus 0.000169991104739584 WBNB, which is $0.1415
  with each fill valued at its own executed rate, on $11.91 of notional
  (118.8 bps of the amount traded).
- Settlement latency across all eight Ophis fills in this report: 7.2 s min,
  9.5 s median, 168.9 s max.
- Five distinct solver addresses submitted the eight settlements, so no single
  solver won all of them. That is a count of winners rather than a measure of how
  many solvers bid: the per-auction ranking is not retrievable for these orders
  (owner review note 2). Each of these settlements carried exactly one trade, so
  no other order was batched alongside ours in these particular auctions.
- Cost per fill: no BNB leaves the agent wallet on the settlement itself, and
  across the seven agent fills the network fee reported inside the settlement
  ranged from 27.88 to 63.32 bps of notional, which is $0.0045 to $0.0127 with
  each fill's fee valued at that fill's own executed rate
  (`derived.feeUsdAtFillPrice`; the 2026-08-18 fill above sits outside both
  ranges, at 21.96 bps and $0.0265). At clip sizes of $1.25 to $2.00 that
  percentage is dominated by the fixed cost of settling, and it is the same
  order of magnitude as the $0.0044 of gas the manual baseline's swap leg cost.
- Both sides of that comparison leave out the ERC-20 approval, and neither path
  avoids one. The manual baseline approves the exact amount it is about to swap
  ($0.0009 of gas, measured above). The agent path does the same before signing:
  `@ophis/agent-swap` asks the wallet for an allowance covering the gross sell
  amount (`swap.js:158`), and the wallet implementations approve exactly that
  amount when the standing allowance is short
  (`ChassisOphisWallet.ensureErc20Allowance` in `apps/agents/src/ophis-wallet.ts`
  for the agents, the same method in `packages/spikes/src/viem-agent-wallet.ts`
  for the 2026-08-18 order), and a settlement consumes that allowance, so the
  next order needs a fresh one. Those approval transactions were not re-read for
  this refresh, so no gas figure is claimed for them, and the line above compares
  settlement fee against swap gas with the approval excluded on both sides.
- Every order declares a CIP-75 volume partner fee of 5 bps to the Ophis
  partner-fee recipient `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`, visible in
  each order's `appData` and in the attached receipt.

**Verdict.** The two 2026-08-18 executions ran two hours apart at different
sizes, so their rates are not directly comparable, and no claim is made from
that pair alone. What the week of fills supports: the auction path settled a
mean of 21.75 bps above the quote the agent held at signing, over seven fills,
with zero human seconds spent, no gas paid from the wallet on any of the
settlements, a downloadable receipt per fill, and nothing sitting in the public
mempool ahead of settlement.
The AMM path cannot return more than pool price minus the LP fee by
construction, needs a person and two transactions each time, and leaves nothing
behind but a transaction hash. The dispersion is stated rather than hidden: one
of the seven fills landed 25.52 bps below its quote and took 169 s.

## Task 2: Find and capture the best USDT lending rate (yield task)

**Manual baseline (not executed, assumption stated).** Nobody sat down and
timed a person doing this, so no time or cost figure is claimed for it, and
none is invented. What is structural rather than measured: the manual path is
two dApp visits, a wallet connection at each, an approval and a deposit at the
winner, repeated every time rates move, and the comparison is stale as soon as
the tab closes. The edge the agent acted on below was 4.75 bps, which is
smaller than the rounding on either venue's public dashboard.

**Agent, on its own capital (executed 2026-08-18,
`evidence/2026-08-18-yield-decision-tick.jsonl` and `evidence/task2-log.jsonl`).**
The Harvester (token 269705) read both venues on-chain inside one tick at
2026-08-18T18:25:13Z: Venus 202.0258 bps against Aave V3 206.7745 bps, with
`blocksPerYear` derived live from two block timestamps (70,048,867) rather than
assumed. It decided "enter aave" and supplied 2.4 USDT (approve
`0x5794d2f96bf79bf74353166b4ecc1951f7dc4336c2ea3e0d15f53321e82146a7`, supply
`0xefa6d0840e9974fdd28700116f152d054e3c5f178417e36d06f85399a30e058f`, block
116703873).

Seven days later, re-read for this refresh:

- The aUSDT position minted at 2.399999999999999999 and reads
  2.400979956867106525 at block 118027877. That is 0.000979956867106526 USDT
  accrued over 6.8981 days (2026-08-18T18:25:14Z to the block's 15:58:34Z),
  216.05 bps annualized on the position.
- At the same block, Venus quotes 239.02 bps and Aave 239.04 bps on USDT, both
  rounded to two decimals from the per-block rates the agent reads. The edge in
  Aave's favour is 0.03 bps (`venueRates.USDT.edgeAaveMinusVenusBps` in the
  attached pull), taken from the two rates before they were rounded, which is why
  subtracting the printed figures gives 0.02 instead: those two figures bound the
  unrounded edge to between 0.01 and 0.03 bps. Anywhere in that range it is far
  inside the 50 bps hysteresis the agent requires on two consecutive checks, so
  it has correctly not moved. Zero rotations here is the policy working, not the
  agent being idle.

**Agent, on a user's funds through the router (executed 2026-08-21).** The part
that did not exist when this report was first written. A depositor's smart
account grants a session key scoped to one `AgripinaaYieldRouter` and its three
selectors, and the router hardcodes every recipient to `msg.sender`, so the
agent can move that position between Venus, Aave, and idle and nowhere else.

- Account `0x47352a5aff2909dcfb46b7f8758c78a868c17988` (an EIP-7702 delegated
  account; the delegation designator reads
  `0xef0100c0f16888f4198f53892c53af859f673e23f26fa3` on-chain).
- One `Rotated` event on the live USDT router
  `0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb`: 2026-08-21T00:02:40Z, block
  117132749, action `toVenus`, 3 USDT, tx
  [`0xe00c6c1f`](https://bscscan.com/tx/0xe00c6c1fcd984891cab6f7fcd4f48059caabf42880ff4dd62696910c62b4e2cb).
  Cost 509,470 gas at 0.05 gwei, 0.0000254735 BNB, about $0.0172. A rotation is
  not a swap, so it has no executed rate of its own: that dollar figure uses
  676.6936 USDT per WBNB, the rate our own fill executed at later the same day
  (the 08-21 Ranger row above). The gas came out of the account's own allowance
  under the session's native-gas cap.
- That position reads 113.44 vUSDT at block 118027877, which is
  3.00085968308128929 USDT of underlying at the market's exchange rate, by
  integer math on the raw balance (`managed.venusPositionNow` in the attached
  pull): 0.00085968308128929 USDT accrued over 4.6638 days
  (2026-08-21T00:02:40Z to the block's 15:58:34Z), 224.27 bps annualized.
- Scanning every block of both live routers from their deploy blocks to
  118026258 returns that one event and no other; the USDC router has none. The
  superseded first router `0x841CF14Dfc0A315115EC5C9714c918210447b260` carries
  two more, a `toAave` and a `toIdle` five seconds apart on 2026-08-20 from
  account `0xacf6fc40…`, which is the deployment test of that router and is
  reported here for completeness rather than as user activity.

**Verdict.** Time: the agent's decision cycle is one on-chain read every six
hours with no human involvement, against a manual comparison that costs
attention every time it is repeated and is stale immediately. Cost: one
approval and one supply on entry, then nothing until an edge clears 50 bps
twice, so the fee floor stays below the yield it is chasing. On the managed
side one rotation cost $0.0172 of gas to move a position between venues.
Quality: the choice is a logged on-chain read with both rates, the block cadence
it derived, and the transaction it produced, and the custody model means the
agent cannot send the money anywhere except back to its owner.

## Task 3: Protect a lending position from liquidation (security-adjacent task)

**Manual baseline (not executed, assumption stated).** No person was timed
babysitting a health factor overnight, so no manual response time is claimed as
a measurement. The assumption used is that a human asleep responds in hours,
not seconds. The penalty is not an assumption: Aave V3 on BSC publishes a
`liquidationBonus` of 11000 for WBNB collateral, meaning a liquidator seizes
collateral worth 110% of the debt it repays: a 10% premium on the debt repaid,
which is 9.09% of the value seized (read from `Pool.getConfiguration` at block
118028579; the same read gives 10500, a 5% premium, on USDT collateral, and a
7500 liquidation threshold on WBNB).

**Agent execution (executed 2026-08-18 on BSC mainnet,
`evidence/task3-drill.jsonl`).** The Guardian (token 269704) polls every 60 s
and repays from a capped budget when the health factor drops below 1.3.

- The drill borrowed 0.65 extra USDT against the agent's own position (tx
  `0x87024c3c961d8bc0495f9c95b7c45cfd1010f36ad9fe16b37a1e8e560a3c2f49`), taking
  the health factor from 2.2634 on the tick before it (18:37:12.834Z) to 1.2490
  at 18:38:12.901Z.
- The agent detected it on its next tick, planned a repay of
  0.318059646689966885 USDT at 18:38:13.069Z (`cappedByBudget: false`), and the
  repay landed at 18:38:14.618Z (tx
  `0x367cb2dc8ab49a0960077ac0e30b58c2d200bc21ecc2bf184c367050b4b0050a`).
  1.717 s from detection to repaid, about 62 s from the degradation itself given
  the 60 s tick. Health factor restored to the 1.600 target. Unattended,
  budget-capped, repay and supply only: it cannot borrow or withdraw.

Seven days later, re-read for this refresh:

- The position is still open and still unattended. At block 118027877 it holds
  $2.79958953 of collateral against $1.13254818 of debt, health factor
  **1.853954**. Those two dollar amounts are Aave's own base-currency figures
  from `Pool.getUserAccountData`, not a conversion of ours. It drifted up rather
  than down because the WBNB collateral appreciated over the week.
- The agent's USDT balance reads 3.131940353310033115. Its balance at the drill
  was 3.45 and it repaid 0.318059646689966885, and 3.45 minus that repay is
  exactly 3.131940353310033115. It has therefore spent nothing since: no second
  repay was needed, and none was made.

**Verdict.** Time: 1.717 s from detection to an on-chain repay, bounded above
by the 60 s poll, against an assumed human response measured in hours.
Cost: one approval and one repay of $0.32, against the 10% premium a liquidator
would have taken on whatever debt it repaid, 9.09% of the collateral seized, had
a liquidation triggered instead. Quality: a timestamped journal of every
health-factor reading, the repair plan with its budget check, and the two
transaction hashes, plus a position that is still standing a week later with the
arithmetic to show nothing else touched it.

## What broke during the week, and what it cost

A track record with a gap in it reads better with the gap explained, so this
section is part of the submission rather than an appendix.

- **Grid starved, 2026-08-19 to 2026-08-24.** Its balance guard refuses a trade
  when the wallet holds less than the clip size. `CLIP_USD` was a constant 2
  while the wallet held 1.9964 USDT, so it was short of its own clip by about
  four tenths of a cent and refused every crossing it detected. The runner
  journal logged **1,559 blocked attempts** with reason `insufficient-balance`
  over those five days (diagnosed 2026-08-24, recorded in commit `33bec21` and
  in the plan's operations log). The code was doing exactly what it was told to
  do; the constant was wrong for the capital available.
- **Ranger stuck, 2026-08-22 to 2026-08-24.** It removed liquidity mid
  rebalance, never re-minted, and kept range-checking the emptied position. All
  three of its position NFTs read `liquidity 0` at diagnosis. The orderbook
  shows the gap directly: no Ranger fill between 2026-08-21T08:42Z and
  2026-08-24T15:41Z. The Grid did fill on 08-22 inside that window; the Ranger
  did not.
- **Both recovered by one deploy on 2026-08-24 at 15:41Z.** The Ranger's
  inventory-prep order was submitted at 15:41:24Z and settled at 15:41:35Z, and
  it minted position **#7248592**, which reads
  `liquidity = 2451189888573570005` at block 118027877 against the three older
  positions still at 0, and sits in range (pool tick -65511 inside its -66170 to
  -65180 band, which is 677.00 to 747.45 USDT per WBNB against a spot of
  699.78). The Grid submitted at 15:45:23Z and settled at 15:45:36Z, with
  `desiredClipUsd: 2, effectiveClipUsd: 1.9963839118921194` in the runner journal
  as quoted in the plan's operations log, selling the whole balance it could
  afford instead of refusing a fixed clip, and it has filled again since
  (2026-08-25 at +124.44 bps).
- **The capital ceiling is the live constraint, not the code.** At block
  118027877 the Grid wallet holds 0.008520134207854582 WBNB and 79 wei of USDT.
  That WBNB balance is exactly its 0.004 WBNB funding leg minus the 0.00326503 it
  sold on 08-19 plus the three amounts it bought on 08-22, 08-24 and 08-25,
  which accounts for every unit of it and leaves the buy side with nothing to
  trade until the sell side fills or the wallet is topped up.

## Evidence index

Everything cited above is in this repository under `docs/evidence/`:

- `2026-08-25-refresh.json`: the full pull behind this refresh. Per-fill order
  uids, signed and executed amounts, fees, surplus and vs-quote figures, each
  fill's own executed rate and the dollar amounts derived from it (`derived`),
  settlement transactions, solvers and latencies; the Ranger's four positions
  with pool ticks; agent balances and Aave account data; the Harvester's
  accrual; live Venus and Aave rates; the router rotations; the four ERC-8004
  identities; the baseline swap's gas; Aave's reserve parameters.
- `task1-baseline.json`: the manual AMM swap.
- `task1-receipt.json`: the Ophis settlement receipt for the 2026-08-18 order.
  Its `surplusVsQuote` field is measured against the signed limit rather than
  against the quote (owner review note 7).
- `2026-08-18-yield-decision-tick.jsonl`: the Harvester tick holding both venue
  rates, the derived block cadence, and the decision.
- `task2-log.jsonl`: the approval and supply that tick produced.
- `task3-drill.jsonl`: the liquidation drill, tick by tick.

## Scoring inputs (TermiX rubric)

- **Value of services (30%).** Eight agents built across four categories. Four
  carry ERC-8004 identities on BSC mainnet, each owned by its own agent wallet
  and serving its manifest at its `tokenURI`, re-read at block 118027877: Grid
  269703, Guardian 269704, Harvester 269705, Ranger 269706. Four more are built
  and tested and wait on the owner's sign-off on their display names before
  registration. Status calls are priced at 0.05 USDT over x402. Execution runs
  at solver-competed prices, and user funds are managed through a router that
  can only ever pay them back to their owner.
- **Proven agent advantage (30%).** This report: eight settlements, one
  liquidation drill, one managed rotation, one week of holding, receipts and
  transactions attached, dispersion and downtime reported alongside the wins.
- **High-stakes categories (20%).** Task 1 is trading, Task 3 is liquidation
  protection with a live drill against the position.
- **Marketplace quality (20%).** Find, compare and hire without instructions at
  https://agripinaa.vercel.app.

## Owner review notes

Open items, all of them things this refresh could not settle from here:

1. **Ophis fee model.** Every live order's `appData` declares a flat 5 bps
   volume partner fee, which is what the pinned `@ophis/sdk` 0.3.0 emits for a
   non-stable pair (1 bp for stable-to-stable). If Ophis's published model has
   moved to a base rate plus price-improvement capture, this report should not
   quote the newer model until the SDK is upgraded and a fresh order shows it.
2. **Solver competition data.** `GET /solver_competition/by_tx_hash` returned
   404 for all eight of our settlements, including the one from 2026-08-25, so
   the per-auction solver ranking is not available to link. The report claims
   only what is on-chain: five distinct solvers across eight settlements. The
   earlier draft's line about solver competition being resolvable on-chain has
   been removed.
3. **The 2026-08-18 Venus and Aave rates** (202.0258 and 206.7745 bps) come
   from the runner journal line attached as evidence. They cannot be re-derived
   today because the public RPCs prune state at that depth, so they are carried
   with their original date and source.
4. **The 1,559 blocked attempts** come from the runner journal on the VM as
   quoted in commit `33bec21` and the plan's operations log, both dated
   2026-08-24. The journal itself is not in the repository (the data directory
   is gitignored and lives on the host).
5. **The 2026-08-25 Grid fill sold 1.5 USDT**, and the wallet held no USDT after
   the 08-24 recovery, so USDT reached it between those two dates. The transfer
   was not traced, and no claim is made about where it came from.
6. **Manual baselines for Tasks 2 and 3 were never executed.** Their comparison
   rests on the stated assumptions, which is why no minutes or dollars are
   quoted for the human side of either.
7. **The receipt's field name.** `evidence/task1-receipt.json` reports the
   +48.61 bps under the key `surplusVsQuote`, but the `buyAmount` it divides by
   is the signed limit, which is the quote with the 50 bps slippage tolerance
   already taken out. The field measures surplus over the signed limit, so it is
   not comparable with the vs-quote column in this report, and both baselines are
   printed wherever that fill appears. The receipt is left exactly as the tool
   wrote it; the field name is worth raising with Ophis rather than editing the
   artifact here.
