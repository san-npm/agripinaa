# World AgentKit: integration feedback

Written 2026-09-12 and 2026-09-13 while adding AgentKit to Agripinaa for
ETHOnline 2026. What we built: the marketplace shows a "Human-backed · World
ID" badge resolved live from AgentBook on each profile; the runner's paid
`GET /:agent/status` (x402, permit2-exact USDT on BSC) grants a human-backed
caller a free trial of three reads per human per endpoint before the normal
payment applies, and its 402 carries the AgentKit challenge. What we could
not do: register the eight agent wallets in AgentBook, because that requires
an Orb-verified World ID and the operator declined biometric verification;
the last section explains what that exposed. Code: `apps/agents/src/agentkit-gate.ts`,
`apps/web/src/lib/agentbook.ts`, the 402 branch of
`apps/agents/src/x402-server.ts`.

## Docs and integration

- The hooks path (`createAgentkitHooks` + `x402HTTPResourceServer`) assumes the
  `@x402/hono` stack. Our x402 server is `node:http` with a different merchant
  library, so we used the "Manual Usage (Advanced)" section. That section is
  complete enough to reimplement the hook in about forty lines, which is good;
  it would be better still if `createAgentkitHooks` exposed the request hook
  against a tiny adapter interface (`getHeader`, `getUrl`) in the README, since
  that is exactly what the hook already takes internally.
- `declareAgentkitExtension()` on its own produces an `info` without `nonce`
  and `issuedAt`. Those are only added by `agentkitResourceServerExtension`
  inside the x402 resource server. A client's `isAgentkitExtension` check
  requires both, so a 402 built with `declareAgentkitExtension` outside that
  stack is silently ignored by `createAgentkitClient`. We had to hand-build the
  block (`agentkitChallenge` in `agentkit-gate.ts`). Suggest either making
  `declareAgentkitExtension` generate nonce and issuedAt itself, or documenting
  that it is not a complete challenge.
- Which chain is canonical for AgentBook is stated three ways. `x402/DOCS.md`
  says the verifier always resolves against World Chain (`eip155:480`);
  `cli/REGISTRATION.md` lists only `base` and `base-sepolia` as supported
  networks and says the hosted relay registers on Base; the CLI's `status`
  command prints `network: "eip155:480"`. We ended up consulting both the
  World Chain and the Base deployment on every lookup. One sentence in the
  README saying which registry a default registration lands in, and whether
  Base registrations are mirrored, would remove the ambiguity.
- `createAgentBookVerifier({ client })` is typed against the library's own
  viem, so passing a client built with the app's viem fails to typecheck in a
  pnpm workspace ("two different types with this name exist"). We used
  `rpcUrl` instead. Declaring viem as a peer dependency would fix it.
- `verifyAgentkitSignature` for an `eip155:56` EOA needed no RPC in practice
  (viem tries ecrecover first), but the docs suggest an RPC is required for
  every EVM chain. Saying "EOA signatures verify offline; RPC is needed for
  ERC-1271/6492 wallets only" would save a config step.

## Developer Portal

- No Developer Portal step was needed for AgentKit itself: registration goes
  through the CLI and World App, verification is an on-chain read. That is a
  real strength. The prize page nevertheless asks for Portal feedback, so it is
  worth stating in the docs that AgentKit needs no app id or action.

## Registration and the Sandbox App: where we stopped

This is the part of the integration we could not complete, and why.

- **AgentBook registration requires an Orb-verified World ID.** The released
  CLI (`@worldcoin/agentkit-cli` 0.2.0) hardcodes the production app id
  (`app_a7c3e2b6b83927251a0db5345bd7146a`) and one action, and `AgentBook.sol`
  verifies proofs against a fixed World ID `groupId`. The operator of this
  project is not willing to hand biometric data to an Orb, so none of the
  eight agent wallets could be vouched for on mainnet. That is a deliberate
  privacy stance, not a tooling failure, but it means the human-backed path
  is exercised here by the automated tests with a stub registry and by the
  live 402 challenge, never by a mainnet lookup that answers "registered".
- **The guide and the CLI disagree.** `cli/REGISTRATION.md` documents
  `--network base | base-sepolia` and a manual mode for other networks. The
  released CLI answers `Unknown flag: --network` and its `register --help`
  offers only `--auto` and `--manual`, both on World Chain. A developer who
  reads the guide first plans a testnet path that does not exist.
- **There is no sandbox path for AgentBook.** The prize brief says to test
  with the World ID Sandbox App. The Sandbox App is real (TestFlight and a
  private Play track, see docs.world.org/world-id/sandbox/sandbox-access) and
  would be the right tool for an operator in exactly our position, but the
  CLI cannot request a proof from a staging app id, and no sandbox AgentBook
  deployment is documented with its group id and external nullifier. A
  `--sandbox` flag on `register`, pointing at a staging app id and a testnet
  AgentBook, plus the two addresses in the README, would have let us register
  all eight agents with simulated identities in ten minutes and demo the free
  trial end to end.
- **Device-level World ID is not an option either.** The contract's single
  `groupId` means the verification level is fixed at deployment; a "Device"
  credential (no Orb) cannot be accepted by the same contract. A second
  AgentBook, or a group id per level, would let a server choose "any human
  with World App" versus "Orb-verified human" as its policy. For a free
  trial of three status reads, the lower bar would have been enough.

## What worked well

- `npx @worldcoin/agentkit-cli status <wallet>` answers in seconds with the
  registry, network and human id fields, exactly what a server needs to debug
  a lookup.
- Per-human rather than per-wallet usage counting is the right primitive for a
  marketplace: one person cannot farm free reads by rotating agent wallets.
- The CAIP-122 challenge binds domain and resource URI, so a header captured
  from one runner cannot be replayed against another. Replay of the same header
  is stopped by the nonce store.

## Open questions

- Is there a hosted or reference persistent `AgentKitStorage`? Every server
  will need one, and the in-memory implementation resets counters on restart.
- Will `lookupHuman` ever be exposed for batch reads (many wallets in one
  call)? A directory page listing dozens of agents would use it.
