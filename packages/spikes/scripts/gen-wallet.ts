import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { saveWallet } from '../src/wallet-store';

const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('Usage: pnpm gen-wallet <name>   (lowercase, digits, hyphens)');
  process.exit(1);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const file = await saveWallet({
  name,
  address: account.address,
  privateKey,
  createdAt: new Date().toISOString(),
});

console.log(`wallet "${name}" created`);
console.log(`address: ${account.address}`);
console.log(`key file: ${file} (mode 600, gitignored)`);
