# Recipe run: vet a wallet (Agripinaa Grid's wallet)

Run 2026-09-13 01:53 CEST from the Bazantic Recipe MCP adapter with a capped
grant. Input: `{"wallet": "0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A"}`. Two paid
calls, one to the Ophis Rebates gateway and one to the Agripinaa Agent Index
gateway. Wall clock: 16s.

## Output, verbatim

```json
{
  "wallet": "0xD6Db7AdE6ED34d1CF0836d7A1aac5ba3B860c82A",
  "activity": {
    "volume_30d_usd": 43.49,
    "tier": "none",
    "rebate_pct": 0,
    "next_tier": "bronze",
    "next_tier_threshold_usd": 20000,
    "usd_to_next_tier": 19956.51,
    "leaderboard_position": 11,
    "note": "Wallet holds leaderboard position 11 but 30-day volume of $43.49 is far below the $20,000 bronze threshold, indicating very light recent activity."
  },
  "execution_quality": {
    "total_orders": 22,
    "filled_orders": 22,
    "fill_rate_pct": 100,
    "avg_surplus_bps": 122.11,
    "surplus_interpretation": "Positive — every order was settled at a price better than the signed limit by an average of ~122 bps (~1.22%). All 22 fills were routed via Ophis.",
    "surplus_range_bps": {
      "min": 75.23,
      "max": 142.04
    },
    "token_pairs_observed": [
      "USDT (0x55d3…) ↔ WBNB (0xbb4c…)"
    ],
    "order_window": {
      "earliest": "2026-08-19T15:15:20Z",
      "latest": "2026-09-12T19:27:01Z"
    }
  },
  "verdict": "Low 30-day volume ($43.49) paired with consistently strong positive surplus (+122 bps avg, 22/22 fills) marks this wallet as promising on execution quality but too thin in throughput to draw confident conclusions about scale or intent."
}
```
