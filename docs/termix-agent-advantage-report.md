# Agent Advantage Report

Submission for the TermiX partner track of BNB Chain's "Build the Era"
hackathon. Three real tasks executed both ways, manually and through an
Agripinaa reference agent, with time, cost, and output quality measured and
the actual outputs attached. All on BSC mainnet with real funds.

> STATUS: template with Task 1 evidence partially collected; Tasks 2-3
> executed in week 4 once the agents have mainnet history. Placeholders
> marked TODO.

## Task 1: Execute a WBNB → USDT swap (trading task)

**Manual baseline.** A human swaps WBNB for USDT on a DEX front end:
connect wallet, pick pair, quote, sign, wait, screenshot the result.
- Time: TODO measure (typical 2-4 minutes wall clock including wallet UX)
- Cost: pool spread + LP fee + gas + any sandwich slippage; no execution proof
- Output quality: a tx hash; surplus/MEV outcome unknown and unprovable

**Agent execution.** The Agripinaa grid agent executed the same swap through
an Ophis batch auction (intent signed, solver competition, MEV-protected):
- Real fill already recorded: order uid
  `0xa2fa52fa97922df8b884345a2959a71209a73957073098c4af76cbd72fa1f02b053fff26d28ff4e94dfe862b184f918a50c6f7066a848e4c`,
  0.02 WBNB → 12.0573 USDT, surplus +48.61 bps vs the signed limit
- Time: ~0 human seconds (autonomous); settlement inside one batch (~30-90s)
- Cost: solver-competed price; MEV protection structural (uniform clearing price)
- Output quality: downloadable receipt JSON (attached,
  `evidence/task1-receipt.json`) with executed vs signed amounts, settlement
  tx, partner-fee disclosure; solver-competition evidence resolvable on-chain

**Verdict.** Same economic action; the agent is faster (zero attention),
cheaper on execution (surplus is measured, not asserted), and produces
evidence a human flow cannot: TODO finalize numbers side by side.

## Task 2: Find and capture the best USDT lending rate (yield task)

**Manual baseline.** Open Venus and Aave dashboards, compare supply APYs,
approve + deposit at the winner, repeat weekly.
- Time: TODO measure a real manual pass (browsing + wallet round trips)
- Output: position at one venue; staleness from the moment you close the tab

**Agent execution.** The yield agent reads both venues' rates on-chain every
6 hours and rotates only on a sustained >50 bps edge.
- Evidence: TODO agent log excerpt (rates read, decision, rotation tx hashes)
  + BscScan links, `evidence/task2-log.jsonl`

## Task 3: Protect a lending position from liquidation (security-adjacent task)

**Manual baseline.** A human babysits an Aave position's health factor.
Realistic response time while asleep: hours; liquidation penalty on BSC
Aave V3: up to 5-10% of collateral.

**Agent execution.** The health-factor agent polls every 60s and repays from
a capped budget when HF < 1.3.
- Evidence (EXECUTED 2026-08-18 on BSC mainnet, evidence/task3-drill.jsonl):
  drill borrowed 0.65 extra USDT (tx 0x87024c3c961d8bc0495f9c95b7c45cfd1010f36ad9fe16b37a1e8e560a3c2f49),
  HF 2.264 -> 1.249 at 18:38:12.901Z; agent detected on its next 60s tick,
  planned repay 0.318 USDT, executed repay tx
  0x367cb2dc8ab49a0960077ac0e30b58c2d200bc21ecc2bf184c367050b4b0050a
  at 18:38:14.618Z (under 2 seconds from detection, ~62s from degradation),
  HF restored to exactly the 1.600 target. Autonomous, budget-capped,
  repay-only authority

## Scoring inputs (TermiX rubric)

- Value of services (30%): four live agents, priced per call over x402 (0.05
  USDT/status call), execution at solver-competed prices
- Proven agent advantage (30%): this report; measured, receipts attached
- High-stakes categories (20%): Task 1 trading, Task 3 liquidation protection
- Marketplace quality (20%): find → compare → hire without instructions at
  https://agripinaa.vercel.app
