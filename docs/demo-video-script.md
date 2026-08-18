# Demo video script (~3 minutes)

Screen recording + voiceover. Two live browser tabs prepared: agripinaa.vercel.app
and BscScan. Terminal visible for the drill. Record AFTER agents have a day
of mainnet history.

## Beat 1 (0:00-0:25): the claim
- Open agripinaa.vercel.app. Read the hero line.
- VO: "This is Agripinaa, the front door for every agent on BSC. A quarter
  million ERC-8004 agents are already registered on BNB Chain. The problem
  is not finding an agent, it is knowing which one to trust. Here,
  performance is provable."

## Beat 2 (0:25-1:00): discovery to decision
- Click Grid trading hub: explainer, ranked table. Click the Agripinaa Grid
  agent profile.
- Point at the three evidence layers: identity (registration tx on-chain),
  reputation, and Execution Quality: real orders, surplus in bps, receipt
  download. Download one receipt, open the JSON briefly.
- VO: "Every trade this agent makes goes through an Ophis batch auction, so
  its track record is settlement data, not marketing. Surplus versus the
  signed limit, on-chain, downloadable."

## Beat 3 (1:00-1:50): the 3-click hire
- Click Activate. Passkey prompt (Face ID on camera if possible). Fund step
  already satisfied. Scope screen: allowlist, daily USDT cap, expiry.
- Grant with one signature. Land on the dashboard: session badge "active
  on-chain", scope visible.
- VO: "Hiring is three clicks and one signature. The agent gets exactly this
  authority: these contracts, this daily cap, this expiry, enforced by the
  account, not by promises. And it is revocable right here."

## Beat 4 (1:50-2:35): the live drill (health-factor agent)
- Terminal: run the drill script (borrows extra USDT against the guarded
  position, pushing HF below 1.3).
- Split screen: agent JSONL log. Within 2 ticks the agent detects and
  repays; show the repay tx landing on BscScan, HF restored.
- VO: "This position just became liquidatable. The guardian agent noticed
  within a minute and repaid from its capped budget. That repay is a session
  key at work: it could never borrow, never withdraw, never exceed its cap."

## Beat 5 (2:35-3:00): close
- Dashboard: revoke the session live; badge flips to revoked.
- Quick pan: four categories, all with live agents; footer fee disclosure.
- VO: "Four categories, four live agents, every fee disclosed, fully open
  source. Agripinaa: browse, verify, hire, revoke. The front door for every
  agent on BSC."

## Shot checklist
- [ ] Grid profile shows >5 fills with surplus
- [ ] Receipt JSON opens cleanly
- [ ] Passkey prompt on camera
- [ ] HF drill: detection <2 min on screen
- [ ] Revoke flips the live badge
