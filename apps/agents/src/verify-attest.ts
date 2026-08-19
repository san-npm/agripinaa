/** Read back the ERC-8004 attestations we wrote, to confirm on-chain. */
import { ERC8004_REGISTRIES } from '@agripinaa/shared';
import { createPublicClient, fallback, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

const abi = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
]);
const pc = createPublicClient({
  chain: bsc,
  transport: fallback(['https://bsc-rpc.publicnode.com'].map((u) => http(u))),
});
const rep = ERC8004_REGISTRIES[56]!.reputation;
const VERIFIER = '0x80c545ef426aa9e46543E5ac2BA4B9728CeB58A1';

for (const id of ['269703', '269704', '269705', '269706']) {
  const r = await pc.readContract({
    address: rep,
    abi,
    functionName: 'getSummary',
    args: [BigInt(id), [VERIFIER], 'agripinaa-verified', ''],
  });
  console.log(`agent ${id}: feedback count ${r[0]}, summary value ${r[1]}`);
}
