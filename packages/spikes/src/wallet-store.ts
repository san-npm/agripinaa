import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** wallets/ sits at the repo root and is gitignored. Plaintext keys are
 * acceptable ONLY for throwaway spike wallets holding tens of dollars. */
const WALLETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'wallets',
);

export interface StoredWallet {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  createdAt: string;
}

export async function saveWallet(w: StoredWallet): Promise<string> {
  await mkdir(WALLETS_DIR, { recursive: true });
  const file = join(WALLETS_DIR, `${w.name}.json`);
  await writeFile(file, JSON.stringify(w, null, 2), { flag: 'wx' });
  await chmod(file, 0o600);
  return file;
}

export async function loadWallet(name: string): Promise<StoredWallet> {
  const file = join(WALLETS_DIR, `${name}.json`);
  return JSON.parse(await readFile(file, 'utf8')) as StoredWallet;
}
