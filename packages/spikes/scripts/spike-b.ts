/**
 * Spike B: prove the Altana session lifecycle on BSC Testnet (97):
 * smart account → session grant (fail-closed calls allowlist + spend cap +
 * expiry) → session-key execute → byte-exact persist/reload → revoke.
 *
 * Prereqs:
 *   1. pnpm gen-wallet spike-b
 *   2. Fund the printed address with tBNB: https://testnet.bnbchain.org/faucet-smart
 *   3. pnpm spike-b
 *
 * Flag-gated follow-ups (run once the basics pass):
 *   X402_URL=<paid endpoint>  adds a client-side x402 paid fetch.
 *   TRY_1271=1                attempts signOrderTypedData (EIP-1271 CoW-order
 *                             signing via session key): the go/no-go for
 *                             session-signed trading agents.
 */
import {
  BNB_TESTNET,
  createClient,
  signerFromPrivateKey,
} from '@altananetwork/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWallet } from '../src/wallet-store';

const WALLETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'wallets',
);

// BSC Testnet USDT (a widely used test deployment); the session may only
// call THIS contract. Any other target must revert.
const ALLOWED_TARGET = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd' as const;

async function main() {
  const stored = await loadWallet('spike-b');
  const signer = signerFromPrivateKey(stored.privateKey);
  const client = createClient({ chains: [BNB_TESTNET] });

  console.log('1) creating smart account (relay-sponsored)…');
  const wallet = await client.createWallet({ signer });
  console.log(`   account: ${wallet.address}`);

  console.log('2) granting session (allowlist + spend cap + 1h expiry)…');
  const session = await client.grantSession({
    wallet,
    signer,
    permissions: {
      // Fail-closed: explicit allowlist, never omitted (omitting = unrestricted).
      calls: [{ to: ALLOWED_TARGET }],
      // 5 units at 18 decimals per day, in smallest units.
      spend: [{ limit: 5n * 10n ** 18n, period: 'day' }],
    },
    expiry: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  console.log('   session granted');

  console.log('3) byte-exact persist + reload…');
  const sessionFile = join(WALLETS_DIR, 'spike-b-session.json');
  const raw = JSON.stringify(session, (_k, v) =>
    typeof v === 'bigint' ? `bigint:${v.toString()}` : v,
  );
  await writeFile(sessionFile, raw, 'utf8');
  const reloaded = await readFile(sessionFile, 'utf8');
  if (reloaded !== raw) throw new Error('persist round-trip NOT byte-exact');
  console.log(`   round-trip byte-exact (${raw.length} bytes) → ${sessionFile}`);

  console.log('4) session-key execute (approve 0 on allowlisted target)…');
  // approve(spender=self, 0): harmless, but a REAL tx through the session key.
  const approveZero =
    '0x095ea7b3' +
    wallet.address.slice(2).toLowerCase().padStart(64, '0') +
    '0'.padStart(64, '0');
  const exec = await client.execute({
    session,
    calls: [{ to: ALLOWED_TARGET, value: 0n, data: approveZero as `0x${string}` }],
  });
  console.log(`   executed: ${JSON.stringify(exec).slice(0, 200)}`);

  console.log('5) negative test: call OUTSIDE the allowlist must fail…');
  try {
    await client.execute({
      session,
      calls: [
        { to: wallet.address, value: 0n, data: '0x' as `0x${string}` },
      ],
    });
    throw new Error('SECURITY FAIL: out-of-allowlist call was accepted');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SECURITY FAIL')) throw err;
    console.log('   correctly rejected');
  }

  console.log('6) revoke…');
  await client.revokeSession({ wallet, signer, session });
  try {
    await client.execute({
      session,
      calls: [{ to: ALLOWED_TARGET, value: 0n, data: approveZero as `0x${string}` }],
    });
    throw new Error('SECURITY FAIL: revoked session still executes');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SECURITY FAIL')) throw err;
    console.log('   revoked session correctly rejected');
  }

  if (process.env.X402_URL) {
    console.log('7) x402 paid fetch…');
    const res = await client.fetchWithX402({ session, url: process.env.X402_URL });
    console.log(`   HTTP ${res.status}`);
  }

  if (process.env.TRY_1271) {
    console.log('8) EIP-1271 order-sign attempt: see signOrderTypedData in');
    console.log('   @altananetwork/sdk; wire a CoW order envelope here and');
    console.log('   submit on 56 to settle the session-signed-trading go/no-go.');
  }

  console.log('\nRESULT: Spike B core lifecycle PASSED on BSC Testnet.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
