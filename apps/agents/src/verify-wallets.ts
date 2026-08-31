/** Verify every synced runner secret against this checkout's public pins. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_LIST,
  FUNDING_FEE_PAYER_BSC,
  MANAGED_TOKENS,
  PRIMARY_MANAGED_TOKEN,
} from '@agripinaa/shared';
import { privateKeyToAccount } from 'viem/accounts';

import { buildManagerKeySet } from './manager-key';

const walletsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'wallets');

function addressFrom(file: string): `0x${string}` {
  const value = JSON.parse(readFileSync(join(walletsDir, file), 'utf8')) as { privateKey?: unknown };
  if (typeof value.privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.privateKey)) {
    throw new Error(`${file}: wallet does not contain a 32-byte private key`);
  }
  return privateKeyToAccount(value.privateKey as `0x${string}`).address;
}

for (const agent of AGENT_LIST) {
  if (agent.wallet === null) continue;
  const address = addressFrom(agent.walletFile);
  if (address.toLowerCase() !== agent.wallet.toLowerCase()) {
    throw new Error(`${agent.walletFile}: wallet does not match the pinned agent address`);
  }
  if (agent.managed && !buildManagerKeySet(agent.slug, MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN)) {
    throw new Error(`agent-${agent.slug}-session.json: managed wallet is missing`);
  }
}

if (addressFrom('facilitator.json').toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()) {
  throw new Error('facilitator.json: wallet does not match the published funding fee payer');
}

console.log('wallet identities verified');
