# ETHOnline 2026 demo video: storyboard (2 to 4 minutes)

Record with the marketplace deployed with `GRAPH_API_KEY` set on Vercel and
in the VM's `ops/ops.env`. No agent wallet is registered in AgentBook (see
`docs/world-agentkit-feedback.md`), so the World beat shows the live
challenge and the test evidence, not a registered read. Screen plus voice.
Keep each beat under 30 seconds.

1. **What this is (0:00).** Agripinaa on BSC: agents registered under ERC-8004,
   with a provable track record. "Continuity project: everything you see was
   live before the event; here is what we added in one day."

2. **The Graph is the index (0:20).** Open `/agents`. Point at the provenance
   line: `Source: the-graph`. Open the network tab or the API:
   `/api/index/agents?category=yield` returns `source: "the-graph"`. One
   sentence on why: Agent0's ERC-8004 subgraph on BSC, newest-first on
   agentId, no `skip` cap.

3. **The Graph decides with the agents (0:50).** `tail -f` the Harvester's
   JSONL on the VM (or paste a tick). Show `theGraph: { venusBps, aaveBps,
   indexedAt }` next to the chain's `venusApyBps`/`aaveApyBps`, and a tick
   with `graphVeto: true` if one has occurred, else explain the rule in one
   line: the chain justifies a rotation, The Graph must agree, or we hold.
   Show the Messari query in `SKILL.md`.

4. **The door for human-backed agents (1:30).** Terminal: `curl` the live
   status endpoint on the tunnel, get a 402 whose `extensions.agentkit`
   carries the CAIP-122 challenge (domain, uri, nonce, free-trial mode).
   Then run `npx tsx --test tests/agentkit-gate.test.ts` in `apps/agents`:
   a vouched-for wallet reads free three times and pays on the fourth, a
   replayed header is refused, a foreign host is refused. Close on the Orb
   paragraph of `docs/world-agentkit-feedback.md`: registration needs an
   Orb-verified World ID, the operator declined, the released CLI has no
   sandbox path. Say it plainly; judges reward that.

5. **Ranger on Uniswap v3 (2:10).** Show `lp-venues.ts` with the probe record
   and `LP_RANGE_VENUE=uniswap-v3`. If a Uniswap position was minted, show
   the position NFT on BscScan and the `pool-selected` log line naming the
   500-tier pool.

6. **Bazantic (2:40).** `baz recipe install`, then the recipe run: "hire the
   best grid agent" returns the agent, the index source, and a settlement tx
   from the receipt. Cut to the raw-API run failing to join proof events to
   the listing, if the comparison was recorded.

7. **Close (3:10).** Repo, the README section separating pre-existing from
   event work, and the links: `SKILL.md`, `FEEDBACK.md`,
   `docs/world-agentkit-feedback.md`, `docs/bazantic/README.md`.
