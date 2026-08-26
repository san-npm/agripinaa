# Submission checklist (deadline: Sep 9, 2026)

## Done and live (nothing to do)

- [x] Marketplace live: https://agripinaa.vercel.app (four hubs, profiles
      with execution quality + receipts, activation wizard, dashboard)
- [x] Four agents live on BSC mainnet, ERC-8004 registered (269703-269706),
      x402-monetized, real economic actions on-chain
- [x] Liquidation drill passed live (evidence + video lever ready)
- [x] TermiX Agent Advantage Report complete with mainnet evidence
- [x] Open source, MIT, public repo: github.com/san-npm/agripinaa
- [x] Hackathon registration submitted (early prototype stage, Aug 7)

## Clément (requires you)

- [ ] **Record the demo video** (~3 min): script + shot checklist in
      docs/demo-video-script.md. The HF drill re-runs any time with
      `pnpm --filter @agripinaa/agents exec tsx src/drill-hf.ts 1 --confirm-mainnet-borrow`
      (this explicitly authorizes a bounded 1 USDT mainnet borrow; keep
      the runner up). Try the passkey wizard once on your phone first.
- [ ] **Walk the full journey once** on a fresh browser: land → category →
      profile → activate (testnet is fine) → dashboard → revoke. You are
      the zero-friction test.
- [ ] **Submit the final entry** on the hackathon page before Sep 9:
      live URL, repo URL, video link, TermiX report
      (docs/termix-agent-advantage-report.md renders on GitHub).
- [ ] Optional but valuable: reply in the 8004scan/AltLayer channel with
      the chain-filter bug report (text ready in the report thread).

## Operational through judging (Sep 9-23 + Phase 2 to Nov 5)

- [ ] Keep the Aleph Cloud VM up: the runner and the tunnel are the systemd
      units `agripinaa-runner` and `agripinaa-tunnel` (ops/launch.md, which
      also covers moving hosts). A tunnel restart needs no manifest edit and no
      redeploy: the VM posts its new hostname to /api/ops/runner-url as
      ExecStartPost on the tunnel unit, the site resolves that base per request
      (`apps/web/src/lib/runner-url.ts`), and
      `apps/web/src/app/manifests/[slug]/route.ts` injects it into every
      manifest at serve time.
- [ ] One-time on Vercel production, or the line above cannot work: set
      OPS_TOKEN (the same value as ops/ops.env on the VM), KV_REST_API_URL and
      KV_REST_API_TOKEN, then redeploy. Without them /api/ops/runner-url
      answers 503 and the site keeps resolving the hostname committed in
      runner-url.ts. Provisioning steps: ops/launch.md, "Env vars this needs".
- [ ] Check agents weekly on the VM: `tail ~/agripinaa/apps/agents/data/*.log.jsonl`;
      breakers clear by deleting the halted flag in
      apps/agents/data/<name>.state.json.
- [ ] rebates.ophis.fi is down (530, since Aug 8): when your Ophis infra
      revives it, agent wallets enroll automatically on next runner boot.

## October (Phase 2 window, optional but planned)

- [ ] ETHOnline feature (Sep 4-13, "Ship a Feature"): The Graph subgraph
      or World ID reviews; both slot into existing seams
- [ ] Merge the ETHOnline feature back here before the Nov 5 announcement
