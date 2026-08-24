/**
 * Register each agent on the ERC-8004 IdentityRegistry (BSC mainnet) with
 * register(agentURI): mints the identity NFT to the agent's own wallet, so
 * the registry's agentWallet metadata points at the wallet whose execution
 * history the marketplace displays.
 *
 * Usage: pnpm --filter @agripinaa/agents register [-- --only grid]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_LIST, BSC_MAINNET, ERC8004_REGISTRIES } from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  fallback,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { manifestUrl, preflightManifests } from './agent-config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS_DIR = join(ROOT, '..', '..', 'wallets');
const REGISTRY_FILE = join(ROOT, 'data', 'registry.json');

const REGISTER_ABI = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const selected = onlyIdx >= 0
    ? AGENT_LIST.filter((a) => (process.argv[onlyIdx + 1] ?? '').split(',').includes(a.slug))
    : [...AGENT_LIST];

  const registryAddress = ERC8004_REGISTRIES[56]!.identity;
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain: bsc, transport });

  const existing: Record<string, { agentId: string; txHash: string }> = existsSync(REGISTRY_FILE)
    ? (JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Record<string, { agentId: string; txHash: string }>)
    : {};

  const pending = selected.filter((record) => !existing[record.slug]);

  // register(agentURI) mints a permanent tokenURI. If that URL 404s, or serves
  // a different agent, the minted identity points at nothing and there is no
  // way to correct it, so the whole run aborts before a single signature.
  if (pending.length > 0) {
    console.log(`preflighting ${pending.length} manifest(s) before signing…`);
    await preflightManifests(pending);
  }

  for (const record of selected) {
    const name = record.slug;
    if (existing[name]) {
      console.log(`${name}: already registered as agentId ${existing[name].agentId}, skipping`);
      continue;
    }
    const walletFile = join(WALLETS_DIR, record.walletFile);
    const { privateKey } = JSON.parse(readFileSync(walletFile, 'utf8')) as {
      privateKey: `0x${string}`;
    };
    const account = privateKeyToAccount(privateKey);
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

    existing[name] = { agentId, txHash: hash };
    mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(existing, null, 2));
    console.log(`${name}: agentId ${agentId} (tx ${hash})`);
    console.log(`  profile: https://agripinaa.vercel.app/agent/56/${agentId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
