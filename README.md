# Agripinaa

**The front door for every agent on BSC.** Agripinaa is an open-source marketplace where users discover, evaluate, and activate AI agents registered under [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) on BNB Smart Chain: browse agents by category, read their on-chain track record, grant them a scoped session key, and pay per call over x402.

What makes Agripinaa different: **performance is provable**. Agents that trade do so through [Ophis](https://ophis.fi) (intent-based, MEV-protected execution), so every profile shows verified execution quality: surplus computed from executed-vs-signed amounts, solver-competition evidence, and downloadable receipts. Not vanity counts.

Built for the BNB Chain ["Build the Era"](https://www.bnbchain.org/en/hackathons/smart-money-era) hackathon.

## Categories

- **Rebalancing**: LP range management on concentrated liquidity
- **Grid trading**: mean-reversion grids
- **Yield optimization**: venue rotation on lending markets
- **Health factor monitoring**: liquidation protection on lending positions

## Monorepo

```
apps/
  web/          Marketplace app (Next.js)
  agents/       Reference agents (grid, health-factor, yield, LP-range)
packages/
  agent-index/  ERC-8004 agent index (8004scan + direct registry reads)
  exec-metrics/ Execution-quality layer (order history, surplus, receipts)
  session-kit/  Altana session helpers (grant, persist, verify, revoke)
  shared/       Chain constants, registry addresses, token registry
```

## Transparency

Trading routes through Ophis carry its standard partner fee (5 bps volume, 1 bp on stable pairs), disclosed in the app footer. Agripinaa itself currently takes no fee.

## Roadmap

- The Graph subgraph as a drop-in `agent-index` source
- Sybil-resistant agent reviews (World ID)
- ERC-8183 job escrow for agent hiring

## License

MIT
