/**
 * Register each agent on the ERC-8004 IdentityRegistry (BSC mainnet) with
 * register(agentURI): mints the identity NFT to the agent's own wallet, so
 * the registry's agentWallet metadata points at the wallet whose execution
 * history the marketplace displays.
 *
 * A mint is permanent and cannot be undone, and a second one for the same
 * agent is a second identity with its own token id, its own attestations and
 * its own profile page: the marketplace would then list the agent twice, and
 * only one of them would be the one the manifests and the proof feed point at.
 * So three separate things have to agree that an agent still needs one before
 * anything is signed:
 *
 *   1. the shared registry record (a tokenId or a registrationTx means done),
 *   2. data/registry.json, the ledger this script writes on the machine that
 *      ran it (gitignored, so it exists only there),
 *   3. the chain itself, asked whether the agent's wallet already holds an
 *      identity.
 *
 * The ledger alone was the old test, which meant a fresh checkout or the VM
 * (neither of which has that file) would preflight and re-mint the four live
 * agents.
 *
 * Usage: pnpm --filter @agripinaa/agents register [-- --only grid-b,yield-b]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_LIST,
  BSC_MAINNET,
  ERC8004_REGISTRIES,
  type AgentRecord,
} from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  fallback,
  http,
  parseAbi,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { manifestUrl, preflightManifests } from './agent-config';
import { parseFlags, type FlagSpec } from './cli-flags';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS_DIR = join(ROOT, '..', '..', 'wallets');
const REGISTRY_FILE = join(ROOT, 'data', 'registry.json');

const REGISTER_ABI = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

/** The ledger this script writes, keyed by slug. */
export type RegistryLedger = Record<string, { agentId: string; txHash: string }>;

/**
 * The whole command line. `--only` takes a value, so an absent or dangling one
 * throws in parseFlags rather than selecting every agent (which is what the
 * old indexOf scan did, on a command that mints).
 */
export const REGISTER_FLAGS: FlagSpec = { value: ['--only'], boolean: [] };

/**
 * The records a run is about. An unknown slug throws: a typo that silently
 * selected nothing would read as "everything is already registered", and one
 * that silently selected everything would put the live agents back in the
 * queue.
 */
export function selectRecords(
  records: readonly AgentRecord[],
  only: string | undefined,
): AgentRecord[] {
  if (only === undefined) return [...records];
  const wanted = only.split(',').map((slug) => slug.trim()).filter((slug) => slug.length > 0);
  if (wanted.length === 0) throw new Error('--only needs at least one agent slug');
  const known = new Set(records.map((record) => record.slug));
  const unknown = wanted.filter((slug) => !known.has(slug as AgentRecord['slug']));
  if (unknown.length > 0) {
    throw new Error(
      `--only: unknown agent slug(s) ${unknown.join(', ')}; known slugs are ${[...known].join(', ')}`,
    );
  }
  return records.filter((record) => wanted.includes(record.slug));
}

/**
 * Why this agent already has an identity, or null when it still needs one.
 * Off-chain sources only, so the whole plan is decided before any RPC call.
 */
export function alreadyRegistered(record: AgentRecord, ledger: RegistryLedger): string | null {
  if (record.tokenId !== null) {
    return `tokenId ${record.tokenId} in packages/shared/src/agents.ts`;
  }
  if (record.registrationTx !== null) {
    return `registration tx ${record.registrationTx} in packages/shared/src/agents.ts`;
  }
  const entry = ledger[record.slug];
  return entry ? `agentId ${entry.agentId} in data/registry.json` : null;
}

/** The records that still need minting, in the order they were selected. */
export function pendingRegistrations(
  records: readonly AgentRecord[],
  ledger: RegistryLedger,
): AgentRecord[] {
  return records.filter((record) => alreadyRegistered(record, ledger) === null);
}

/**
 * The last check before signing: does this wallet already hold an ERC-8004
 * identity? That is the case the two off-chain sources cannot see (a mint that
 * landed on another machine, or one whose token id was never written back), and
 * it is one cheap read.
 *
 * Fails CLOSED. A read that does not answer leaves the question open, and the
 * action on the other side of it is permanent, so the run stops instead.
 */
export async function assertNoIdentityYet(
  client: Pick<PublicClient, 'readContract'>,
  registry: `0x${string}`,
  slug: string,
  wallet: `0x${string}`,
): Promise<void> {
  let held: bigint;
  try {
    held = await client.readContract({
      address: registry,
      abi: REGISTER_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    });
  } catch (err) {
    throw new Error(
      `${slug}: could not read the identity registry for ${wallet} (${err instanceof Error ? err.message : String(err)}); refusing to mint without confirming it holds none`,
    );
  }
  if (held > BigInt(0)) {
    throw new Error(
      `${slug}: ${wallet} already holds ${held} ERC-8004 identit${held === BigInt(1) ? 'y' : 'ies'} on this registry; refusing to mint a second. Read its token id from the Registered event on BscScan and put it in packages/shared/src/agents.ts, then re-run.`,
    );
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), REGISTER_FLAGS);
  const selected = selectRecords(AGENT_LIST, flags.value('--only'));

  const registryAddress = ERC8004_REGISTRIES[56]!.identity;
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain: bsc, transport });

  const ledger: RegistryLedger = existsSync(REGISTRY_FILE)
    ? (JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as RegistryLedger)
    : {};

  for (const record of selected) {
    const reason = alreadyRegistered(record, ledger);
    if (reason) console.log(`${record.slug}: already registered (${reason}), skipping`);
  }
  const pending = pendingRegistrations(selected, ledger);
  if (pending.length === 0) {
    console.log('nothing to register');
    return;
  }

  // register(agentURI) mints a permanent tokenURI. If that URL 404s, or serves
  // a different agent, the minted identity points at nothing and there is no
  // way to correct it, so the whole run aborts before a single signature.
  console.log(`preflighting ${pending.length} manifest(s) before signing…`);
  await preflightManifests(pending);

  for (const record of pending) {
    const name = record.slug;
    const walletFile = join(WALLETS_DIR, record.walletFile);
    const { privateKey } = JSON.parse(readFileSync(walletFile, 'utf8')) as {
      privateKey: `0x${string}`;
    };
    const account = privateKeyToAccount(privateKey);
    await assertNoIdentityYet(publicClient, registryAddress, name, account.address);
    const walletClient = createWalletClient({ account, chain: bsc, transport });

    const agentURI = manifestUrl(record);
    console.log(`${name}: registering ${account.address} with URI ${agentURI}…`);
    const hash = await walletClient.writeContract({
      address: registryAddress,
      abi: REGISTER_ABI,
      functionName: 'register',
      args: [agentURI],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${name}: registration reverted (${hash})`);

    let agentId: string | null = null;
    for (const logEntry of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: REGISTER_ABI, data: logEntry.data, topics: logEntry.topics });
        if (decoded.eventName === 'Registered') {
          agentId = (decoded.args as { agentId: bigint }).agentId.toString();
        }
      } catch {
        /* other events in the receipt */
      }
    }
    if (!agentId) throw new Error(`${name}: Registered event not found in receipt ${hash}`);

    ledger[name] = { agentId, txHash: hash };
    mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(ledger, null, 2));
    console.log(`${name}: agentId ${agentId} (tx ${hash})`);
    console.log(`  profile: https://agripinaa.vercel.app/agent/56/${agentId}`);
    console.log(`  put tokenId '${agentId}' and registrationTx '${hash}' on the ${name} record in packages/shared/src/agents.ts`);
  }
}

// Only when invoked directly: importing this module must never mint anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
