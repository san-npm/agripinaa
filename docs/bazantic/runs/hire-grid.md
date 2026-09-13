# Recipe run: hire an agent, category grid

Run 2026-09-13 01:53 CEST from the Bazantic Recipe MCP adapter (`baz recipe mcp`)
with a capped grant paying one cent per gateway call in USDC on Base. Input:
`{"category": "grid"}`. Model: anthropic/claude-sonnet-4.6, hosted by Bazantic.
Wall clock: 59s.

## Output, verbatim

I now have all the data needed. Let me compile the final answer.

**Summary of ranking (2 grid candidates):**
1. 🥇 **307485 "Agripinaa BTC Grid"** — avg surplus 127.54 bps, 4 fills
2. 🥈 **269703 "Agripinaa Grid"** — avg surplus 122.11 bps, 22 fills

Winner is **Agripinaa BTC Grid (307485)** — highest average surplus among candidates. Its newest event (trade) has orderUid with receipt confirming settlement tx `0x460d31353e745262f9837eae4ac94479998a312f75f0d44578ad4ad6bcea400f`, block 119937606, surplus 121.19 bps.

```json
{
  "agent": {
    "tokenId": "307485",
    "name": "Agripinaa BTC Grid",
    "profileUrl": "https://agripinaa.vercel.app/agent/56/307485"
  },
  "indexSource": {
    "lane": "the-graph",
    "note": "Category=grid returned zero items from the-graph paginated index; the two first-party grid agents (269703, 307485) were identified via their agentWallet addresses embedded in Ophis order UIDs found in the getProofFeed runner log, which carried source=runner+chain. The listAgents source field reported for the initial query is 'the-graph'."
  },
  "executionQuality": {
    "rankedCandidates": 2,
    "candidates": [
      {
        "rank": 1,
        "tokenId": "307485",
        "name": "Agripinaa BTC Grid",
        "agentWallet": "0x4a66d9f68ca6be7a44fdb891c0346c2381bf0d6d",
        "fills": 4,
        "avgSurplusBps": 127.542830448523
      },
      {
        "rank": 2,
        "tokenId": "269703",
        "name": "Agripinaa Grid",
        "agentWallet": "0xd6db7ade6ed34d1cf0836d7a1aac5ba3b860c82a",
        "fills": 22,
        "avgSurplusBps": 122.11161980345595
      }
    ],
    "winnerFills": 4,
    "winnerAvgSurplusBps": 127.542830448523,
    "rankingBasis": "Average surplus in bps against signed limit (higher is better); ties broken by fill count"
  },
  "latestFill": {
    "summary": "Filled USDT → BTCB through Ophis",
    "time": "2026-09-04T14:50:29.687983Z",
    "orderUid": "0xcf3b5e5f7cb845ab18f0ea2105b1f16051bbf890fbffb6bd78a0d55312058c2e4a66d9f68ca6be7a44fdb891c0346c2381bf0d6d6a9ae1b9",
    "settlementTxHash": "0x460d31353e745262f9837eae4ac94479998a312f75f0d44578ad4ad6bcea400f",
    "settlementBlock": 119937606,
    "surplusBps": 121.194803140906,
    "sellToken": "0x55d398326f99059ff775485246999027b3197955",
    "buyToken": "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    "executedSellAmount": "1500000000000000000",
    "executedBuyAmount": "18964440689948",
    "chainId": 56
  },
  "activationUrl": "https://agripinaa.vercel.app/agent/56/307485/activate"
}
```
