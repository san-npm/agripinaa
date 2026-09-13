# Four-agent provisioning operational record

Last updated: 2026-08-27 (Europe/Luxembourg)

This file contains no private keys. Signer secrets exist only in the gitignored
`wallets/` directory, whose files are owner-readable (`0600`). Never print,
commit, regenerate, or copy those keys outside the deployment workflow.

## Public identities

| Agent | Token | Wallet | Registration |
| --- | ---: | --- | --- |
| Agripinaa BTC Grid (`grid-b`) | `307485` | `0x4A66d9f68CA6be7A44fDb891C0346c2381BF0D6d` | `0xbb75b0bb6620b85ae53d38235b410a85c507b161ea0ad673167fc0a7d40d85eb` |
| Agripinaa Venus Guardian (`venus-guardian`) | `307486` | `0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173` | `0xf0c59a0aae6a8f94e7aa899488de869515ec93743c0c850df5d425cdd21e40a0` |
| Agripinaa Steward (`yield-b`) | `307487` | `0x454aC9bae8cC6eA1067F7422992A9Ab2e8DCEdF3` | `0x4d3d55f3c17290a7e3dc04349f6e2ad5422b1cfb3aea46a3110500c07dc5a85e` |
| Agripinaa Rebalancer (`weight-rebalancer`) | `307488` | `0x2516deB9E76995fd7eb0911AacEA441c12ccc98C` | `0xcf6a2d2c86cc72e8c4c02e772ada6be228abaae2136d7f4d5b5a0e69ffbbc77c` |

The Steward manager pins are public configuration:

- USDT master: `0xFC194cec123CBeb323951813c932800c4A86DD03`
- USDC derived key: `0xac6a37C49A2875c37f1a70A249D9080482ffF346`

These pins were rotated on 2026-08-29 after relay call
`0xa17195ab0e796c52ca56e3eb8d899aa0a3b9e3f0ecee7c9ef6141a49f8ba6bf4`
remained pending without a BNB Chain transaction. The retired manager wallet is
kept locally at `wallets/retired/agent-yield-b-session.pre-reset-20260829.json`
and is excluded from VM sync. Its signed mandate expires at
`2026-09-04T22:58:23Z`; keep it offline unless that call lands and revocation is
required.

The dedicated verifier is
`0x80c545ef426aa9e46543E5ac2BA4B9728CeB58A1`.

## Funding and first executions

The four wallets were funded from the existing `spike-a` source according to
their registry plans. The source acquired the missing USDT and BTCB through
the canonical PancakeSwap V3 router, revoked its temporary router allowance,
and transferred only the planned assets.

Two agents have qualifying first executions:

- `yield-b` supplied `0.9 USDT` to Venus in transaction
  `0xbf543e86567cbfd26e2d9cfbbc9136076d71070a7814dbdffa23655da028d40b`.
- `venus-guardian` detected a deliberately approved Venus drill at health
  factor `1.27` and repaid `0.442891721262516486 USDT` in transaction
  `0xd9817ea31984019038303cbcb1aeea46bc44ae98bd6fe0ef0bdc83a1a80f5808`.
  Follow-up ticks read a healthy factor of about `1.599`. The wallet retains
  roughly `0.0049 BNB` supplied as collateral and about `1.734 USDT` debt, so
  the Guardian must remain deployed and funded to monitor it.

`grid-b` initialized its BTCB/USDT ladder but has not crossed a level.
`weight-rebalancer` initialized near its 50/50 target and stayed inside its
five-point drift band. Neither has a qualifying fill yet; do not attest either
registration or passive telemetry as execution.

## ERC-8004 attestations

| Agent | Attestation | Feedback hash | Proof |
| --- | --- | --- | --- |
| `venus-guardian` | `0xdd938692c2c3f6eb1f6813171e177e1d9af20882ad0324871ba3d1cc954eb450` | `0x244903446100c31d00763a40478eb52ec4407b346b46f2183bee7718117197f8` | Venus repair above |
| `yield-b` | `0xec7cf7f7b13bdd4607d0cef66e0a6bc2ce70d78e0851bbd40b1f615ce09f95f3` | `0xebf6999d9f572a91a835f849ae304cfa41f007a68a21c5b0b50e9bd5f129ba28` | Venus supply above |

Both ReputationRegistry summaries were read back as one feedback item with
value `100` and zero decimals. `grid-b` and `weight-rebalancer` remain
registered but unverified until their own logs show a filled or settled Ophis
order. Use `harvest` first; a submitted order alone is not a proof.

## Operational notes

- `chassis.ts`, `fund.ts`, and `attest.ts` use viem's nonce manager for
  sequential writes against lagging RPCs.
- The guarded wallet transport recovers the deterministic transaction hash
  only when a backend explicitly reports the identical signed raw transaction
  as `already known`. It does not treat a generic low-nonce error as success.
- The local runner was stopped cleanly after the Venus drill. Deployment owns
  restarting all registered modules.
- The original four agents remain tokens `269703` through `269706` and were not
  re-funded, re-registered, or re-attested.

## Continuing natural proof collection

1. Keep the production runner healthy and preserve its gitignored JSONL logs.
2. Harvest proofs with:

   ```bash
   pnpm --filter @agripinaa/agents harvest
   ```

3. For `grid-b` or `weight-rebalancer`, require a corresponding fill/settlement
   line before attesting. Then dry-run the single agent and compare its anchor:

   ```bash
   pnpm --filter @agripinaa/agents attest --only <slug> --dry-run
   pnpm --filter @agripinaa/agents attest --only <slug>
   ```

4. Verify the receipt and ReputationRegistry summary, then deliberately pin the
   attestation and proof in `packages/shared/src/agents.ts` with exact tests.

## Verification baseline

At provisioning time the shared, agent, and web test suites passed; the full
workspace CI typecheck passed; the Next.js production build completed all eight
first-party static agent paths; and `git diff --check` was clean.
