# Agent Advantage Report

TermiX evidence for Agripinaa in BNB Chain's Build the Era hackathon. The
official track asks for at least three real tasks run both ways—with an agent
hired through the marketplace and without one—and asks for time, cost, output
quality, and the actual outputs for each.

## Audit status

This report now contains three same-boundary comparisons with raw outputs. A
Pashov review on 2026-08-28 rejected the original third comparison because the
manual path performed a swap while the marketplace path prepared two assets,
granted Ranger, and later minted an LP position. Its preparation transaction
also preceded Ranger's session grant, so it was owner-authorized activation
work rather than agent execution.

That rejected comparison remains an explicitly non-counted appendix. It was
replaced with a post-mint reconciliation task that begins after the same hired-
session mint and produces the same normalized output on both paths. Pashov's
follow-up review passed it as distinct from the later range-decision task, with
the presentation condition that detection latency must not be called compute
time.

The machine-readable accounting is in
[`evidence/2026-08-28-termix-hired-comparisons.json`](evidence/2026-08-28-termix-hired-comparisons.json).

## Cost and timing conventions

Altana relays the account's transactions. Two costs therefore appear:

- **User cost** is the relay `paymentAmount` charged to the managed account,
  plus any separately visible KeyStore debit.
- **Network gas** is `gasUsed × effectiveGasPrice` paid by the relay
  transaction sender. It is evidence about chain work, not a substitute for
  the user's charge.

Manual RPC reads submit no transaction and therefore have zero chain cost.
Manual scripts have monotonic wall-clock timings. Historical production logs
do not contain a matching monotonic start time for each agent tick, so the
report does not manufacture like-for-like agent latency figures from block
timestamps.

Agripinaa does not sponsor these costs and charges no managed-service fee. The
user-controlled strategy account pays its own activation and execution costs.

## Comparison 1: choose the better USDT supply venue

Shared task boundary: read Venus and Aave's USDT supply rates and choose the
higher one. Harvester's subsequent supply and monitoring are reported as extra
output rather than being used to make the decision boundary look better.

### Without an agent

At 2026-08-28T20:18:05.163Z a manual script read two BSC block timestamps,
Venus `supplyRatePerBlock()`, and Aave V3 `getReserveData(USDT)` using the same
exported rate math as Harvester.

- Time: 454 ms for four RPC reads.
- User and chain cost: zero.
- Output: Venus 263.704230 bps, Aave 239.053452 bps, choice `venus`.
- Quality: a point-in-time recommendation; it created no position.
- Actual output: `tasks.chooseUsdtSupplyVenue.withoutAgent` in the
  [machine-readable attachment](evidence/2026-08-28-termix-hired-comparisons.json).

### With marketplace-hired Harvester

Harvester had been granted a scoped session on the user's Altana account. On
2026-08-21 it read Venus at 208.595289 bps and Aave at 208.296746 bps and chose
`venus`.

- Decision time: the production output is timestamped
  2026-08-21T00:02:42.910Z. No per-tick monotonic start was recorded, so an
  exact compute duration is unavailable and no latency win is claimed.
- Decision cost: the reads themselves were off-chain RPC calls with zero chain
  cost.
- First executed use after hiring: the session grant confirmed at 23:58:41Z;
  the Venus supply confirmed 3 minutes 59 seconds later.
- First-task user cost from a funded account: 0.000931067240678528 BNB. This is
  0.00008100833 BNB relay payment plus 0.000763748985678528 BNB KeyStore debit
  for the grant, then 0.000086309925 BNB for the supply relay.
- Recurring execution user cost without a new grant: 0.000086309925 BNB.
- Network work: grant 870,865 gas; supply 509,470 gas, both at 0.05 gwei.
- Extra output quality: Harvester supplied 3 USDT and received 11,344,002,822
  raw vUSDT units. Five minutes later it read 3.000000588914912606 USDT in
  Venus and held because Aave's lead was only 0.120179 bps.
- Actual outputs:
  [`2026-08-21-harvester-managed-output.jsonl`](evidence/2026-08-21-harvester-managed-output.jsonl),
  [session grant](https://bscscan.com/tx/0x6cf958403db7e4f7136664d539becc68f2cb645b5d039280442c414c4f25bfc1),
  and [Venus supply](https://bscscan.com/tx/0xe00c6c1fcd984891cab6f7fcd4f48059caabf42880ff4dd62696910c62b4e2cb).

The two decisions occurred at different market times, so the rate figures do
not prove better yield selection. They prove that both paths independently
chose Venus and that the hired path also executed and monitored the choice.

## Comparison 2: recover the position created by a completed mint

This task begins after Ranger's hired-session mint transaction
`0xf042…c5678` has confirmed. Its completion condition is to identify the
minted NFT and its immutable tick bounds. Mint execution time and cost are
context, not part of this post-confirmation verification.

### Without an agent

A manual verifier read the receipt, decoded the NFT ID, then read
`positions(7271073)`.

- Time: 268.678 ms for two RPC reads.
- User and chain cost: zero.
- Output: transaction success, token ID 7271073, tick range -66059 to -65085.
- Actual output:
  [`2026-08-28-ranger-mint-manual-output.json`](evidence/2026-08-28-ranger-mint-manual-output.json).

### With marketplace-hired Ranger

Ranger reconciled its confirmed pending mint during the next scheduled sweep
and persisted the position required for later monitoring.

- Detection time: approximately 9 minutes 55.8 seconds after the confirmation
  block timestamp. This is next-sweep detection latency, not active computation
  time; Ranger's active computation duration was not recorded.
- User and chain cost for reconciliation: zero; no transaction was submitted.
- Normalized output: transaction success, token ID 7271073, tick range -66059
  to -65085.
- Actual production output:
  [`2026-08-28-ranger-mint-recovery-output.jsonl`](evidence/2026-08-28-ranger-mint-recovery-output.jsonl).

Both paths produced the same position identity and range. Manual verification
was faster. Ranger's advantage was unattended, durable recovery that
automatically supplied state to subsequent range monitoring.

## Comparison 3: decide whether Ranger needs rebalancing

Shared task boundary: inspect Pancake V3 position 7271073 and output `hold` or
`rebalance`. The comparison isolates one decision; the longer unattended
history is an additional benefit.

### Without an agent

At 2026-08-28T20:18:26.240Z the manual script read NFT ownership, position
data, the canonical pool address, and `slot0()`.

- Time: 376 ms for four RPC reads.
- User and chain cost: zero.
- Output: current tick -65356 inside -66059 to -65085, liquidity
  6457605562311526187, decision `hold`.
- Actual output: `tasks.decideWhetherRangerNeedsRebalancing.withoutAgent` in
  the [machine-readable attachment](evidence/2026-08-28-termix-hired-comparisons.json).

### With marketplace-hired Ranger

Ranger checked the same position at 20:13:31.648Z, 4 minutes 54.592 seconds
before the manual read.

- Per-check time: the output has an end timestamp but no monotonic start, so no
  like-for-like process latency is claimed. Checks are scheduled approximately
  every ten minutes.
- Recurring read cost: zero chain cost.
- Output: current tick -65362 inside -66059 to -65085, decision `hold`.
- Extra output quality: the attached production window contains all 30 raw
  checks from 15:32:04.154Z through 20:13:31.648Z. All were in range, so Ranger
  submitted no no-op transaction and incurred no monitoring gas.
- Actual outputs:
  [`2026-08-28-ranger-managed-checks.jsonl`](evidence/2026-08-28-ranger-managed-checks.jsonl),
  [session grant](https://bscscan.com/tx/0xb2d10f8149426dc787901a8438c17435b934e5dbfce1744b281a51b21ae6eb15),
  [checker grant](https://bscscan.com/tx/0x9acd4913d8894ac03321ab97c0a0b81a55c847d43ba32481734655aa44ab39c6),
  and [agent mint](https://bscscan.com/tx/0xf0429b522926bb9b87835d7435ef4974beb6ad50cea59d9924334559db2c5678).

The in-range window proves monitoring without unnecessary churn. It does not
prove the configured 30-minute out-of-range persistence rule because no check
in this window was out of range.

## Activation UX appendix: not counted as the third task

On 2026-08-28 the user selected Ranger and funded once with BNB. The owner
authorized a preparation bundle that wrapped 0.012156784025527638 BNB, sold
half, and left 0.006078392012763819 WBNB plus 4.309104290455045067 USDT. That
transaction confirmed before Ranger's key was registered, so it demonstrates
the activation UX rather than agent execution.

Ranger was then granted, its Ophis checker was added, and it minted user-owned
Pancake position 7271073. From preparation submission to mint confirmation the
full flow took 24,906 seconds (6 h 55 min 6 s), four transactions, and
0.000958880720769938 BNB of user-visible Altana/KeyStore charges.

The available manual artifact started from 0.0008 WBNB, approved Pancake, and
swapped it for 0.482844230664355319 USDT in 2.021 seconds. It used two
transactions, 175,746 gas, and 0.0000087873 BNB. It did not prepare two balanced
legs or mint an LP NFT. These outputs are real, but they are different tasks and
must not be sold as a controlled agent win.

Actual outputs:

- [`task1-baseline.json`](evidence/task1-baseline.json)
- [manual approval](https://bscscan.com/tx/0x6b8a369b955a09bbdb155cb3e2478a7e4afef716f0fb27ddc6fc5feca7517dec)
- [manual swap](https://bscscan.com/tx/0xa72d0e47e172d490396303b953b5369942e7be1f200f17abba6d9e3b806f40d4)
- [owner preparation](https://bscscan.com/tx/0x279a32de4a34115057efaa71322ef90944335d384bc303638a0d3491811fb91c)
- [Ranger mint](https://bscscan.com/tx/0xf0429b522926bb9b87835d7435ef4974beb6ad50cea59d9924334559db2c5678)

## Trading history appendix

Seven fills were executed by the Grid and Ranger agent wallets from 2026-08-19
through 2026-08-25. One earlier Ophis fill came from the separate comparison
wallet. Across all eight fills, six beat the independent quote held at signing:
75%, mean about +18.83 bps, worst -25.52 bps, best +51.14 bps, and five winning
solver addresses. Two—not one—finished below the signing quote.

Risk and limitations:

- fill notionals ranged from about $1.25 to $12.06;
- signed tolerance was 0.5% for the comparison-wallet fill and 1% for the seven
  agent-wallet fills;
- Grid has a 5% inventory drawdown halt;
- Ranger's 30-minute persistence rule and four-actions-per-week breaker are
  runner-local strategy controls, not KeyStore-enforced authority limits;
- one fill took 168.9 seconds.

Full per-fill data is in
[`evidence/2026-08-25-refresh.json`](evidence/2026-08-25-refresh.json).

## Rubric coverage

| Requirement | Evidence |
| --- | --- |
| Three real tasks, both ways | Venue choice, post-mint reconciliation, and live range decision each use a shared stopping condition. |
| Marketplace-hired agent | Harvester and Ranger acted through sessions granted from Agripinaa's activation flow. |
| Time | Manual monotonic timings are reported; agent detection/cadence is reported separately where active compute time was not instrumented. |
| Cost | User relay/KeyStore charges, network gas, and zero-cost reads are kept separate. |
| Output quality | Agent execution, durable recovery, and unattended repetition are separated from the normalized task outputs. |
| Actual outputs | Manual JSON, raw production JSONL, relay IDs, and BSC receipts are linked. |
| Trading or security | Ranger's Pancake V3 position reconciliation and rebalance decision are trading/LP-management tasks. |
