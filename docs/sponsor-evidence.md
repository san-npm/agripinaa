# Sponsor evidence and form copy

Use this as the copy-and-paste handoff for the current Build the Era Google
form and for sponsor judging. Public evidence was re-read on 2026-08-28.

Official challenge criteria:
https://www.bnbchain.org/en/hackathons/smart-money-era

## Current form answers

**Project Name**

Agripinaa

**One-Line Pitch**

A user-controlled BSC marketplace where anyone can discover, hire and revoke
eight live ERC-8004 DeFi agents; six have execution-backed attestations.

**Project Description**

Agripinaa is a public marketplace for 288,944 BSC ERC-8004 agents, with eight
first-party agents across grid trading, yield optimisation, liquidation
protection and LP rebalancing. Users activate any agent from one BTCB, BNB,
USDT or USDC deposit. A passkey-controlled Altana account grants an expiring
session with direct-call selector and spend limits plus an ERC-1271 checker over
approved dedicated-account inventory; users track positions and revoke inside
the app. Agents execute through PancakeSwap V3, Ophis, Aave and Venus. 8004scan
Pro powers discovery and trust provenance, x402 monetizes live status, and six
agents have execution-backed ReputationRegistry attestations. Live evidence and
the TermiX report are linked in the repository.

This is 748 characters including spaces, below the form's 800-character limit.

**Sub-prize tracks**

Select all three choices currently present in the form:

- PancakeSwap
- AltLayer
- TermiX

The official hackathon page also lists Best Built with Altana, but the current
form does not provide an Altana checkbox. Name Altana explicitly in Additional
Notes.

**Project GitHub Repo Link**

https://github.com/san-npm/agripinaa

**Prototype Stage**

Working MVP

**Additional Notes**

Live product: https://agripinaa.vercel.app

TermiX Agent Advantage Report:
https://github.com/san-npm/agripinaa/blob/main/docs/termix-agent-advantage-report.md

Sponsor evidence:
https://github.com/san-npm/agripinaa/blob/main/docs/sponsor-evidence.md

Also entering Best Built with Altana. Mainnet Altana account:
https://explorer.altana.network/account/0x47352a5aff2909dcfb46b7f8758c78a868c17988

The account registered a scoped Ranger session in KeyStore and used that
session to mint Pancake V3 position 7271073. Users can inspect the allowlist,
spend caps and expiry in My sessions and revoke inside the product. All eight
first-party agents are registered on BSC, six carry execution-backed on-chain
reputation attestations, and the two without qualifying executions are clearly
shown as unverified.

**Required owner-supplied fields**

Fill these from your personal details rather than a project key:

- full name, email, country and timezone, social handles;
- solo builder or team details;
- availability and consent questions;
- prize wallet. Use a wallet you personally control. Do not use an agent,
  facilitator, verifier, or managed strategy account as the prize wallet.

## Main track evidence

Agripinaa is live at https://agripinaa.vercel.app and the source is public at
https://github.com/san-npm/agripinaa.

| Category | First-party agents | ERC-8004 identities |
| --- | --- | --- |
| Grid trading | Agripinaa Grid, Agripinaa BTC Grid | [269703](https://agripinaa.vercel.app/agent/56/269703), [307485](https://agripinaa.vercel.app/agent/56/307485) |
| Health factor | Agripinaa Guardian, Agripinaa Venus Guardian | [269704](https://agripinaa.vercel.app/agent/56/269704), [307486](https://agripinaa.vercel.app/agent/56/307486) |
| Yield optimisation | Agripinaa Harvester, Agripinaa Steward | [269705](https://agripinaa.vercel.app/agent/56/269705), [307487](https://agripinaa.vercel.app/agent/56/307487) |
| Rebalancing | Agripinaa Ranger, Agripinaa Rebalancer | [269706](https://agripinaa.vercel.app/agent/56/269706), [307488](https://agripinaa.vercel.app/agent/56/307488) |

All eight have public BSC identities and live activation routes. Six have
execution-backed ReputationRegistry attestations. BTC Grid and Rebalancer are
registered and usable but do not receive a Verified badge until their own
strategy produces a qualifying execution.

The end-to-end journey is public: land, browse by category, inspect identity
and execution evidence, activate from one supported asset, view the session and
live position, then revoke or withdraw.

## Best Built with Altana

Official qualification mapping:

| Requirement | Agripinaa evidence |
| --- | --- |
| Agent wallet | User-owned Altana smart account [`0x4735...7988`](https://explorer.altana.network/account/0x47352a5aff2909dcfb46b7f8758c78a868c17988). First-party runners also use separate wallets. |
| Real limits | Ranger session expires at 2026-08-29T10:52:44Z. Direct calls are limited to Pancake position-manager `mint`, `decreaseLiquidity`, and `collect`, plus the pinned Altana relay permission. An ERC-1271 checker authorizes canonical Ophis settlement over inventory already approved from this dedicated account. Daily hard ceilings are 1,000,000 USDT, 100 WBNB, and 0.005 BNB. The token ceilings are broad inventory guards; expiry, account isolation, and the 0.005 BNB native-value-and-gas ceiling are tighter. The three Pancake functions accept recipient/position arguments and have no argument checker, so the compromised-manager maximum-loss boundary is inventory and LP principal in this dedicated account, not only the displayed spend counters. |
| KeyStore registration | [Key registration transaction](https://bscscan.com/tx/0xb2d10f8149426dc787901a8438c17435b934e5dbfce1744b281a51b21ae6eb15), KeyStore `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a`. The key was valid when captured. |
| Session-key execution | [Ranger mint transaction](https://bscscan.com/tx/0xf0429b522926bb9b87835d7435ef4974beb6ad50cea59d9924334559db2c5678), submitted as Altana relay call `0xe892439e...05d67`. |
| User control | My sessions live-reads KeyStore validity and displays the saved human-readable policy, spend ceilings, and expiry. The runner separately verifies the exact live permission maps before accepting a handoff. Revoke is in-product; [a previous key revocation](https://bscscan.com/tx/0xa777b423663de7ae8c021e8ab95c9adafbb880b65a5870fbd906f6941c93ddef) proves the path on mainnet. |
| Bonus x402 | Every first-party status endpoint serves a 0.05 USDT x402 challenge through `@altananetwork/x402-server`. |

Exact captured direct-call, relay, checker, and spend authority is attached in
[`evidence/2026-08-28-sponsor-proof.json`](evidence/2026-08-28-sponsor-proof.json).

Suggested Altana submission sentence:

> Agripinaa gives every user a passkey-controlled Altana strategy account and
> grants the hired agent an expiring KeyStore session limited to three Pancake
> selectors, the pinned Altana relay, a canonical Ophis settlement checker, and
> published daily token and native-value-and-gas ceilings over a dedicated
> strategy account. The
> selectors accept arguments, so account isolation—not recipient binding—is the
> custody boundary. On BSC mainnet Ranger used
> that session to mint user-owned Pancake V3 position 7271073. The product
> displays live KeyStore validity, its saved policy, and the position, and lets
> the owner revoke in one passkey confirmation.

## TermiX

The audited three-task report is documented at
[`termix-agent-advantage-report.md`](termix-agent-advantage-report.md).

It compares:

1. a timed manual Venus/Aave rate decision versus Harvester's managed decision
   and supply;
2. manual recovery of a minted Pancake NFT and its range versus Ranger's
   unattended recovery of the same output;
3. a timed manual Pancake position check versus a matched Ranger decision and
   30 unattended Ranger checks.

The report separates actual Altana user charges from relayer network gas and
attaches the raw Harvester output plus all 30 Ranger decisions. The trading
appendix reports eight settled fills, a 75% win rate against the quote held at
signing, the observation window, best and worst results, notional range,
slippage limits, and strategy risk controls.

Suggested TermiX submission sentence:

> The attached Agent Advantage Report contains three Pashov-reviewed,
> same-boundary mainnet comparisons with raw production outputs, full
> activation-cost accounting, and an eight-fill trading record. It preserves
> the rejected activation comparison as a non-counted appendix and states
> plainly whenever manual verification was faster.

## PancakeSwap

Ranger is designed to benefit Pancake V3 liquidity providers:

- one BTCB, BNB, USDT, or USDC deposit is prepared into WBNB and USDT;
- the agent mints a user-owned concentrated-liquidity position;
- it checks the live tick every ten minutes;
- it waits 30 minutes out of range before acting, which avoids transient churn;
- its implemented and tested policy can close, collect, rebalance inventory
  through an Ophis batch auction, and re-mint around the current price;
- the honest runner's local policy caps combined inventory preparation and
  position rebalances at four per week.

Mainnet evidence:

- [one-deposit inventory preparation](https://bscscan.com/tx/0x279a32de4a34115057efaa71322ef90944335d384bc303638a0d3491811fb91c);
- [session-executed Pancake mint](https://bscscan.com/tx/0xf0429b522926bb9b87835d7435ef4974beb6ad50cea59d9924334559db2c5678);
- [user-owned position 7271073](https://bscscan.com/nft/0x46A15B0b27311cedF172AB29E4f4766fbE7F4364/7271073);
- 30 production range checks from 15:32:04Z to 20:13:31Z, all in range,
  attached in the TermiX comparison artifact.

This captured run proves preparation, mint, ownership, liquidity, and
monitoring. Because the position remained in range, it does not prove a
completed close/collect/Ophis-rebalance/re-mint cycle; that lifecycle is
implemented and tested but was not exercised in this evidence window.

Suggested PancakeSwap submission sentence:

> Agripinaa Ranger turns one supported deposit into a user-owned WBNB/USDT
> Pancake V3 position, monitors its range continuously, and re-centers only
> after a persistent 30-minute breach. The live mainnet session minted position
> 7271073 and completed 30 checks without unnecessary churn. Direct-call,
> checker, relay, expiry, spend, and dedicated-account boundaries constrain the
> on-chain authority; the two inventory ceilings are intentionally broad and the
> Pancake calls are not recipient-bound. A separate runner-local breaker limits
> combined preparation and rebalances to four per week.

## AltLayer and 8004scan

The marketplace uses the 8004scan Pro API as its primary BSC discovery and
trust source. The public server-side endpoint reported:

- source: `8004scan-pro`;
- BSC agents: 288,944;
- as of: 2026-08-28T20:21:08.998Z;
- per-record trust provenance: `8004scan`.

Public endpoint:
https://agripinaa.vercel.app/api/index/agents?limit=1

Implementation:
[`packages/agent-index/src/sources/scan8004.ts`](../packages/agent-index/src/sources/scan8004.ts).
Agripinaa keeps the API key server-side, applies BSC filtering, labels data
freshness and provenance, and falls back to a committed BSC snapshot plus
direct IdentityRegistry reads when the indexer is unavailable. First-party
on-chain ReputationRegistry data can override only the score fields it proves;
8004scan remains labelled as the profile source.

Suggested AltLayer submission sentence:

> Agripinaa uses 8004scan Pro as the primary discovery and trust layer for
> 288,944 BSC ERC-8004 agents. It exposes chain-scoped search and category
> browsing, labels source and freshness per field, and combines 8004scan with
> direct registry reads and a snapshot fallback so degraded upstream service
> does not turn the marketplace into an empty or misleading directory.

## Public contracts and addresses

| Purpose | Address |
| --- | --- |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0CeB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Altana KeyStore | `0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a` |
| Managed account | `0x47352a5aff2909dcfb46b7f8758c78a868c17988` |
| Pancake V3 position manager | `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` |
| Pancake V3 WBNB/USDT pool | `0x172fcD41E0913e95784454622d1c3724f546f849` |
| Current guarded USDT YieldRouter | `0x67c0005C2a9709a28DA42cEC9b11b8a7201B4C22` |
| Current guarded USDC YieldRouter | `0x4A2E2817736D8497EeB4296dd5e51ECAeA427f72` |

These are evidence and protocol addresses, not the prize payout wallet.
