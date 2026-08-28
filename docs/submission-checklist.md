# Submission checklist

Official build deadline: 2026-09-09 12:00 UTC. Judging runs through
2026-09-23. The official page requires a functional public product with live
BSC agents. It does not require a video or a separate manual dress rehearsal.

## Complete

- [x] Public marketplace: https://agripinaa.vercel.app
- [x] Public MIT repository: https://github.com/san-npm/agripinaa
- [x] Eight first-party agents registered on BSC under ERC-8004
- [x] Two live first-party agents in each required category: grid trading,
      yield optimisation, health factor monitoring and rebalancing
- [x] All eight have activation routes and public status services
- [x] Six agents have execution-backed ReputationRegistry attestations. BTC
      Grid and Rebalancer remain correctly labelled unverified until they earn
      qualifying execution evidence
- [x] One-deposit activation supports BTCB, BNB, USDT and USDC
- [x] Altana mainnet account, KeyStore registration, exact session limits,
      session-key transaction and revocation evidence captured
- [x] Pancake V3 user-owned position 7271073 minted and monitored by Ranger
- [x] 8004scan Pro integration live with per-field provenance and fallback
- [x] TermiX Agent Advantage Report has three Pashov-reviewed same-boundary
      tasks, corrected user-cost accounting and raw Harvester/Ranger outputs
- [x] Form-ready sponsor copy assembled in
      [`sponsor-evidence.md`](sponsor-evidence.md)

## Owner action required

- [ ] Edit the team's existing Google Form response rather than creating a
      second entry, because the rules allow one entry per team. If the edit
      link is unavailable, ask the organizer how to update the Aug 7 response.
- [ ] Copy the project fields and Additional Notes from
      [`sponsor-evidence.md`](sponsor-evidence.md).
- [ ] Select PancakeSwap, AltLayer and TermiX. The current form omits Altana, so
      Additional Notes explicitly enters Best Built with Altana and links the
      Altana explorer account.
- [ ] Supply the personal/team identity fields and an ERC-20/BEP-20 prize
      wallet you personally control. Do not use an agent, facilitator, verifier
      or managed strategy account as the payout wallet.
- [ ] Confirm the edited response was received before 2026-09-09 12:00 UTC.

No video is needed under the current Build the Era page or Google Form. The
existing `demo-video-script.md` is optional promotional material only.

## Keep public through judging

- [ ] Keep the Vercel production deployment healthy.
- [ ] Keep the Aleph Cloud `agripinaa-runner` and `agripinaa-tunnel` system
      services healthy.
- [ ] Keep `OPS_TOKEN`, `KV_REST_API_URL` and `KV_REST_API_TOKEN` configured in
      Vercel. The VM's `ops/ops.env` remains optional at systemd load time but
      must exist when the authenticated activation lease is used.
- [ ] Check the eight profile and activation routes plus the proof, funds,
      agents and sessions pages after any production deploy.
- [ ] During judging, change only what fixes a demonstrated bug, security issue
      or outage. A formal feature freeze is not an official requirement.
