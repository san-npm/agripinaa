import { MergedSource } from '../src/index';
import { Scan8004Source } from '../src/sources/scan8004';
import { readAgentFromRegistry } from '../src/sources/registry-viem';

const tokenId = process.argv[2] ?? '269704';

const scan = new Scan8004Source();
try {
  const viaScan = await scan.getAgent(56, tokenId);
  console.log('scan:', viaScan ? { name: viaScan.name, category: viaScan.category } : 'null');
} catch (err) {
  console.log('scan threw:', err instanceof Error ? err.message : err);
}

const viaRegistry = await readAgentFromRegistry(56, tokenId);
console.log(
  'registry:',
  viaRegistry
    ? { name: viaRegistry.name, category: viaRegistry.category, uri: viaRegistry.agentURI }
    : 'null',
);

const merged = new MergedSource();
const viaMerged = await merged.getAgent(56, tokenId);
console.log(
  'merged:',
  viaMerged ? { name: viaMerged.name, category: viaMerged.category, source: viaMerged.trust.source } : 'null',
);
