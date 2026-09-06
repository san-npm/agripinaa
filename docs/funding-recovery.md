# Funding recovery pilot

This contains a **single-account alternate funding sender** connected to the
activation wizard, plus an operator-only recovery command for older hosted-relay
attempts. The code is deployed on production; direct sending is enabled only for
the approved account after explicit key-installation approval. Live passkey
activation remains to be verified. This is not a general relay replacement.

The command defaults to simulation. It has not been used to broadcast on BSC.
User deposits and production wallet keys were not touched during testing.
Ponytail scope: reuse the funding merchant policy, fee cap, atomic state writer,
SDK submission callback and existing runner; no additional provider service.

The September 6 first direct attempt exposed a missing passkey envelope in the new
sender. Porto sends raw WebAuthn bytes at this RPC boundary; `Key.wrapSignature`
must add the key hash and prehash byte before Orchestrator execution. The correction
passed a full read-only BSC simulation of the exact reported request. Native payer
signatures and already-wrapped hosted recovery signatures are not wrapped again.
See the investigation log for the before/after evidence. No activation was broadcast.

## September 6 deployment status

- Web and runner code: `b0678e60aa3eda93378416d93a63a02ed0c5c1ce`.
  Vercel production deployment: `dpl_8PGN2BXbDhofPapzoq3Z6h8PGFVs`.
- Production browser-bundle checks passed; runner health reports all eight agents.
  Funding mode initially returned `enabled: false`; gateway health/capabilities and BTCB
  fee-quote reads return HTTP 200.
- Under the approved live-test gas budget, the existing project gas-funding wallet
  funded the new dedicated sender `0x270C1136Eab831b0D5c18aA1BBCcf87d95bd14F7`
  with 0.00015 BNB. Transfer
  `0x063d635b03bf639ab1ad8c5325109880ded22ee475cad04843d8629cdccbce82`
  succeeded with a fee of 0.00000105 BNB. No activation was submitted; the user's
  BTCB balance and account nonce were unchanged.
- The full deployment script was blocked by automated review because it copies
  wallet credentials. A code-only deployment succeeded using existing remote keys;
  no wallet file was transferred in that deployment. After subsequent explicit
  approval, **only the new dedicated key** was copied from `wallets/direct-funding.json` to
  `agripinaa-aleph:/root/agripinaa/wallets/direct-funding.json`, over pinned SSH.
  Its derived public address and mode 0600 were verified remotely; no other key was copied.
- The runner loads the enabled account and dedicated key path from
  `/etc/systemd/system/agripinaa-runner.service.d/direct-funding.conf`.
  The source configuration is retained locally at `ops/run/direct-funding.conf`.
  Production funding mode now returns `enabled: true` for the approved account and
  `false` for an unrelated account. Runner and tunnel are healthy after restart.
  No activation journal exists: a fresh browser passkey signature is still needed.
  To disable new sends, set `DIRECT_FUNDING_ENABLED=false` in that drop-in, run
  `systemctl daemon-reload`, and restart `agripinaa-runner`; keep the key and journals.
- Local operator setup and the signed gas-transfer journal are retained under
  `apps/agents/data/prepare-direct-funding.ts` and
  `apps/agents/data/direct-funding-gas-transfer.json`. Use `--status`; do not fund again.

## Browser activation path

The browser selects its sender before signing. Unless the runner explicitly enables
the account, execution continues through the existing hosted sender. A selected
direct submission never falls back to hosted submission on error.

The same buffered registration budget is used by the funding quote, reserve swap
and SDK registration call. The budget adds 2% (rounded up) to the current fee;
the merchant rechecks it against the live fee, retaining the existing absolute
cap. This tolerates small fee changes, not an arbitrarily old quote. Other SDK
registration paths also use the buffered fee reader.

For a direct submission, a random intent nonce binds the account and a five-minute
submission deadline to the browser's funding ID. The existing checkpoint is saved
after the passkey signature but **before** submission. The runner checks the signed
funding policy and simulates the full transaction before saving signed outer
transaction bytes and sending. Reloads and retries check the saved ID; they do not
sign, swap, or charge again. An unknown ID stays pending until its submission
deadline; an in-flight or stale process lock keeps it pending. A saved transaction
without a receipt remains pending even after that deadline.

The browser uses `/api/funding/relay`; the server proxies to the runner's
OPS-token-protected `/internal/funding-relay`. The signing key stays on the runner.
The gateway forwards only read-only `health` and BSC capability requests to Altana
for SDK compatibility. Merchant quote preparation and authorization lookup still
use Altana; this bypasses hosted **submission and status**, not every dependency.

### Enablement — requires live execution approval

Deploy the runner and web changes together, with direct sending initially disabled.
After approval for the account, dedicated gas wallet and live transaction budget,
configure the runner with:

```text
DIRECT_FUNDING_ENABLED=true
DIRECT_FUNDING_ACCOUNT=<approved first-activation account>
FUNDING_RECOVERY_KEY_FILE=<owner-only JSON file containing privateKey>
```

`OPS_TOKEN` must also be configured on the runner and web service. The dedicated
sender needs native BNB and must not be the user or fee-payer wallet. No wallet is
automatically funded. The existing signed bootstrap payment reimburses the sender;
the maximum gas cost is capped by that signed payment and never exceeds 0.0002 BNB.

The pilot accepts **one account and one retained transaction**, stored in
`apps/agents/data/direct-funding.json` (or the configured data directory).
Keep that journal and any stale lock for operator review; do not delete them to
retry. Confirmation requires three block confirmations and the matching successful
Orchestrator event. Turning off the flag disables sending but leaves status reads
available. This does not repair old hosted IDs or clear browser checkpoints.

Before calling the marketplace restored, verify a live activation, session grant,
runner registration, strategy execution and safe exit/withdrawal. Local simulations
and mocked SDK tests do not establish those outcomes.

## Preconditions

- The requested ID must be the account's latest Altana history entry, status 300,
  with no transactions or receipts. Pending/unknown entries are never retried.
- The attempt must be less than 24 hours old. Its signed swaps, registration fee,
  fee budget, signatures and authorization nonces must still be valid.
- The user's account must be untouched (first activation). An already initialized
  fee payer is supported only with the pinned delegation.
- Use a **separate dedicated gas wallet**, never the user or facilitator wallet.
  There must be no pending transaction from that sender. Do not use it elsewhere.
- The signed intent must pass the existing funding policy and a full type-4
  `eth_call` with no state overrides. Gas is capped at 2,000,000; its maximum cost
  cannot exceed the already signed fee amount (at most 0.0002 BNB).

The only changed intent field is `paymentRecipient`, which is explicitly excluded
from the intent signature. It becomes the dedicated sender that advances gas.
Calls, amounts, user signatures and fee-payer signatures are not rewritten.
This follows the existing Orchestrator payment mechanism, not a new deposit.

## Read-only simulation

From the repository root, replace the three uppercase placeholders with addresses/ID:

```sh
pnpm --filter @agripinaa/agents exec tsx src/recover-funding.ts ACCOUNT CALLS_ID DEDICATED_GAS_WALLET
```

The default RPC is `https://bsc-dataseed.bnbchain.org`. Only this approved public
endpoint or a loopback fork can receive the signed payload. A real simulation
requires enough native BNB already in the dedicated sender; the command never
funds it or reads a signing key in simulation mode.

## Broadcast — requires separate approval and a live verification plan

Do not enable this just because a simulation passed. Obtain approval for the gas
budget and live funding execution first. If approved, provide an owner-only JSON
key file containing `privateKey` through `FUNDING_RECOVERY_KEY_FILE` and add
`--broadcast` to the command above. Never put the key itself on the command line.

The signed raw transaction is written and fsynced before submission. The single
retained `apps/agents/data/funding-recovery.json` journal blocks every new recovery
until operator review. **Keep it** after any timeout, failed receipt, or lost reply.
Rerunning the command checks its receipt only; it does not sign, rebroadcast,
refresh a quote, or fund again. Loopback runs use a separate local data directory.
A stale process lock requires manual inspection; it is never automatically removed.

Confirmation requires a successful receipt and the matching Orchestrator
`IntentExecuted` event with the expected account, intent nonce, `incremented=true`
and zero error. Missing receipts/events are uncertainty, not permission to retry.
An on-chain failure can still consume gas or payment; inspect before taking action.

After confirmed recovery, check native/token balances, approvals and registered
admin key before resuming the activation wizard. The original Altana ID will
still be failed; this tool does not modify relay history or browser checkpoints.
Session grants, autonomous execution, revocation and withdrawal still need live
end-to-end verification. This pilot alone does not make the marketplace ready.

## Checks

```sh
pnpm --filter @agripinaa/agents exec tsx --test tests/recover-funding.test.ts
pnpm --filter @agripinaa/agents exec tsx --test tests/direct-funding-relay.test.ts tests/funding-execution.test.ts
pnpm typecheck:ci
pnpm test
pnpm build
```

For the optional fork check, start a fresh loopback Anvil BSC fork and promptly run:

```sh
anvil --host 127.0.0.1 --port 18556 --chain-id 56 --base-fee 0 --fork-url https://bsc-rpc.publicnode.com --silent
# In a second terminal:
pnpm --filter @agripinaa/agents exec tsx tests/recover-funding.fork.ts
```

The fork check uses disposable test-owned EOA authorities, local USDT/BNB fixtures,
the real deployed contracts, and a 0.05-gwei fee fixture (Anvil otherwise suggests
1 gwei). It simulates the complete ten-call funding batch, checks both fresh and
already-delegated payers, rejects invalid signatures and excessive fees, signs
the outer transaction locally, and restores the fork snapshot. **No broadcast**,
including on the fork. It does not substitute for a live passkey activation test.
PublicNode rejects pruned historical state without an archive token; restart a
fresh fork if it reports that error. Never bypass the production policy checks.

## Observed limitation of the user's old attempt

On September 5, the attempt ending `dae6379` included a registration payment of
643,173,666,243,097 wei. The later live quote required 648,140,581,995,046 wei.
The recovery policy correctly refused it. That establishes a stale-fee problem
for reusing this old signature, **not the cause of the relay's original rejection**.
A stale signed amount cannot safely be edited: it requires a fresh user signature,
not another deposit. The buffered quote and browser integration above address those
implementation gaps; live passkey activation and end-to-end acceptance remain outstanding.
