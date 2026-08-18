/**
 * Spike B part 2: x402 pay-per-call hello-world on BSC Testnet (97), fully
 * self-contained: a local merchant (@altananetwork/x402-server, permit2-exact
 * rail, test USDT) and an Altana session-key buyer (fetchWithX402).
 *
 * The permit2-exact/USDT combination is exactly what the mainnet reference
 * agents will charge in; only the token address differs.
 *
 * Flow: mint test USDT → one-time Permit2 provisioning (admin) → fresh
 * session → GET without payment (expect 402) → fetchWithX402 (expect 200 +
 * on-chain settlement).
 */
import {
  BNB_TESTNET,
  createClient,
  PERMIT2_ADDRESS,
  signerFromPrivateKey,
} from '@altananetwork/sdk';
import { createX402Merchant } from '@altananetwork/x402-server';
import { createServer } from 'node:http';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';

import { loadWallet } from '../src/wallet-store';

const RPC = 'https://bsc-testnet-rpc.publicnode.com';
/** Agripinaa TestUSD (aTUSD): our own public-mint ERC-20 on 97, deployed from
 * packages/spikes/contracts/TestUSD.sol (the "official" testnet USDT's mint
 * is owner-only). */
const TEST_USDT = '0xFfee7137D74fecFe7DB79FF6688E27fd8dED4e28' as const;
const PORT = 4402;
const PRICE = parseUnits('0.1', 18); // 0.1 test-USDT per call, 18 decimals on BNB

async function main() {
  const stored = await loadWallet('spike-b');
  const signer = signerFromPrivateKey(stored.privateKey);
  const client = createClient({ chains: [BNB_TESTNET] });
  const transport = http(RPC);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });

  // The EOA key still signs plain txs (EIP-7702 delegation does not remove
  // that ability); used here for gas-paid provisioning.
  const eoaAccount = privateKeyToAccount(stored.privateKey);
  const eoaWallet = createWalletClient({ account: eoaAccount, chain: bscTestnet, transport });

  console.log('0) minting 10 test USDT to the account…');
  const balance = await publicClient.readContract({
    address: TEST_USDT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [eoaAccount.address],
  });
  if (balance < parseUnits('1', 18)) {
    const mintHash = await eoaWallet.sendTransaction({
      to: TEST_USDT,
      data: ('0xa0712d68' + parseUnits('10', 18).toString(16).padStart(64, '0')) as `0x${string}`,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log(`   mint: ${r.status}`);
  } else {
    console.log(`   already funded (${Number(balance) / 1e18} USDT)`);
  }

  console.log('1) facilitator: fresh key, funded with 0.05 tBNB for settle gas…');
  const facilitatorKey = generatePrivateKey();
  const facilitator = privateKeyToAccount(facilitatorKey);
  const fundHash = await eoaWallet.sendTransaction({
    to: facilitator.address,
    value: parseUnits('0.05', 18),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`   facilitator: ${facilitator.address}`);

  console.log('2) starting local merchant (permit2-exact, 0.1 USDT/call)…');
  const merchant = createX402Merchant({
    chainId: 97,
    chain: bscTestnet,
    rpcUrl: RPC,
    payTo: facilitator.address,
    price: PRICE,
    rails: [
      {
        rail: 'permit2-exact',
        token: { address: TEST_USDT, name: 'Agripinaa Test USD', version: '1', symbol: 'aTUSD', decimals: 18 },
        spender: facilitator.address,
      },
    ],
    facilitator,
    resource: `http://localhost:${PORT}/status`,
    description: 'Agripinaa spike: paid status endpoint',
  });

  const server = createServer(async (req, res) => {
    const result = await merchant.requirePayment(req.headers['x-payment'] as string | null);
    if (result.status === 402) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        paidBy: result.receipt.payer,
        amount: result.receipt.amount.toString(),
        settlementTx: result.receipt.txHash,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  console.log('3) unpaid GET must 402…');
  const unpaid = await fetch(`http://localhost:${PORT}/status`);
  if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);
  console.log('   402 challenge served');

  console.log('4) buyer provisioning (admin, one-time): Permit2 approvals…');
  const wallet = await client.createWallet({ signer });
  await client.approveTokenForPermit2({ wallet, signer, token: TEST_USDT });
  console.log('   token approved for Permit2');

  console.log('5) fresh session + signature-checker approval…');
  const session = await client.grantSession({
    wallet,
    signer,
    permissions: {
      calls: [{ to: TEST_USDT }],
      spend: [{ limit: parseUnits('1', 18), period: 'day' }],
    },
    expiry: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  await client.approveSignatureChecker({ wallet, signer, session, checker: PERMIT2_ADDRESS });
  console.log('   session granted, Permit2 approved as signature checker');

  console.log('6) paid fetch via session key…');
  const paid = await client.fetchWithX402({ session, url: `http://localhost:${PORT}/status` });
  const body = (await paid.json()) as Record<string, unknown>;
  console.log(`   HTTP ${paid.status}: ${JSON.stringify(body)}`);
  server.close();

  if (paid.status !== 200) {
    console.error('\nRESULT: x402 paid call FAILED');
    process.exit(1);
  }
  console.log('\nRESULT: x402 hello-world PASSED (402 → session-signed payment → 200 + settlement).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
