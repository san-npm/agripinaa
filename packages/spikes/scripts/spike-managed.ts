/**
 * Spike: the manager-key model for agent-managed funds.
 *
 * Proves, on BSC testnet, the security-critical unknowns before building the
 * real feature:
 *   1. A session can authorize an AGENT-held key via a verify-only signer
 *      stub (the agent's private key never enters the "browser").
 *   2. The agent, holding only its own private key, reconstructs the session
 *      and client.execute()s a scoped call FROM the user's smart account.
 *   3. An out-of-scope selector reverts (call scoping is enforced).
 *   4. After revoke, the next execute reverts (kill switch works).
 *
 * Uses spike-b's testnet smart account (0xACF6…, holds aTUSD + tBNB) as the
 * "user", a fresh manager key as the "agent", and aTUSD as the token.
 *
 * Usage: pnpm --filter @agripinaa/spikes exec tsx scripts/spike-managed.ts
 */
import {
  BNB_TESTNET,
  createClient,
  signerFromPrivateKey,
} from '@altananetwork/sdk';
import { encodeFunctionData, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { loadWallet } from '../src/wallet-store';

const ATUSD = '0xFfee7137D74fecFe7DB79FF6688E27fd8dED4e28' as const;
const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const DEAD = '0x000000000000000000000000000000000000dEaD' as const;

function verifyOnlyStub(address: `0x${string}`, publicKey: `0x${string}`) {
  // Mirrors a secp256k1 Signer but cannot sign: grantSession only reads
  // publicKey/address/type, so the agent's private key is never needed here.
  return {
    type: 'privateKey' as const,
    address,
    publicKey,
    signDigest: () => {
      throw new Error('verify-only stub: cannot sign (agent key is off-browser)');
    },
  };
}

async function main() {
  const admin = await loadWallet('spike-b');
  const adminSigner = signerFromPrivateKey(admin.privateKey);
  const client = createClient({ chains: [BNB_TESTNET], defaultChainId: 97 });

  console.log('1) reconstruct the user smart account (admin = passkey/EOA)…');
  const wallet = await client.createWallet({ signer: adminSigner });
  console.log(`   account: ${wallet.address}`);

  // --- agent side: a manager keypair. Only its PUBLIC parts go to the browser.
  const managerPk = generatePrivateKey();
  const manager = privateKeyToAccount(managerPk);
  console.log(`2) agent manager key: ${manager.address} (private key stays on the agent)`);

  console.log('3) BROWSER grants a session to the agent pubkey via a verify-only stub…');
  const permissions = {
    // Scoped to ONLY aTUSD.approve — proves selector scoping (transfer must fail).
    calls: [{ signature: 'approve(address,uint256)', to: ATUSD }],
    spend: [
      { limit: parseUnits('5', 18), period: 'day' as const, token: ATUSD },
      // A small NATIVE cap so the session can pay its own gas in tBNB.
      { limit: parseUnits('0.02', 18), period: 'day' as const },
    ],
  };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const granted = await client.grantSession({
    wallet,
    signer: adminSigner,
    sessionSigner: verifyOnlyStub(manager.address, manager.publicKey) as never,
    permissions,
    expiry,
  });
  console.log(`   granted, session pubkey ${granted.publicKey.slice(0, 14)}…`);

  console.log('4) AGENT reconstructs the session with only its own private key…');
  const session = {
    walletAddress: wallet.address,
    signer: signerFromPrivateKey(managerPk),
    publicKey: manager.publicKey,
    permissions,
    expiry,
  };

  console.log('5) AGENT executes a SCOPED call (aTUSD.approve) from the user account…');
  const okTx = await client.execute({
    session: session as never,
    chainId: 97,
    calls: [{ to: ATUSD, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [DEAD, 0n] }) }],
  });
  console.log(`   OK: ${JSON.stringify(okTx).slice(0, 160)}`);

  console.log('6) AGENT tries an OUT-OF-SCOPE call (aTUSD.transfer) — must fail…');
  try {
    await client.execute({
      session: session as never,
      chainId: 97,
      calls: [{ to: ATUSD, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [DEAD, 1n] }) }],
    });
    throw new Error('SECURITY FAIL: out-of-scope transfer was accepted');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SECURITY FAIL')) throw e;
    console.log('   correctly rejected (selector not allowlisted)');
  }

  console.log('7) revoke, then the next scoped execute must fail…');
  await client.revokeSession({ wallet, signer: adminSigner, session: session as never });
  try {
    await client.execute({
      session: session as never,
      chainId: 97,
      calls: [{ to: ATUSD, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [DEAD, 0n] }) }],
    });
    throw new Error('SECURITY FAIL: revoked session still executes');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SECURITY FAIL')) throw e;
    console.log('   revoked session correctly rejected');
  }

  console.log('\nRESULT: manager-key model PROVEN — grant-to-agent-key (no key in browser),');
  console.log('scoped execute from the user account, selector scoping, and revoke kill switch.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
