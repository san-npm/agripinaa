/**
 * Recovery primitives shared by the operator CLI and the gated first-funding sender.
 * The CLI defaults to simulation. No automatic fallback or replacement transaction.
 * See docs/funding-recovery.md before enabling a broadcast.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ALTANA_ORCHESTRATOR_BSC, FUNDING_BOOTSTRAP_FEE_WEI, FUNDING_FEE_PAYER_BSC } from '@agripinaa/shared';
import {
  createPublicClient, decodeAbiParameters, decodeEventLog, encodeAbiParameters,
  encodeFunctionData, http, keccak256, parseAbi, parseAbiParameters,
  parseTransaction, recoverTransactionAddress,
  type Address, type Hex, type PublicClient, type SignedAuthorization, type TransactionReceipt, type TransactionSerialized,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { recoverAuthorizationAddress } from 'viem/utils';

import { DATA_DIR, ensureDataDir, writeStateFile } from './chassis';
import { fundingRequestFromExecution, requireReimbursedFundingRequest } from './funding-merchant';
import { boundedLegacyFees, knownRawTransactionHash } from './guarded-wallet-client';

const DELEGATION = '0xc0f16888f4198f53892c53af859f673e23f26fa3';
const IMPLEMENTATION = '0x4b5d20cd8a3927b500540d9bccddc27385c9fa79';
const ZERO = '0x0000000000000000000000000000000000000000';
const RELAY = 'https://relay.altana.network';
const PUBLIC_RPC = 'https://bsc-dataseed.bnbchain.org';
const HASH_RE = /^0x[\da-f]{64}$/i;
const ADDRESS_RE = /^0x[\da-f]{40}$/i;
const INTENT_ABI = parseAbiParameters('(address eoa,bytes executionData,uint256 nonce,address payer,address paymentToken,uint256 paymentMaxAmount,uint256 combinedGas,bytes[] encodedPreCalls,bytes[] encodedFundTransfers,address settler,uint256 expiry,bool isMultichain,address funder,bytes funderSignature,bytes settlerContext,uint256 paymentAmount,address paymentRecipient,bytes signature,bytes paymentSignature,address supportedAccountImplementation)');
const ORCHESTRATOR_ABI = parseAbi([
  'function execute(bytes encodedIntent) returns (bytes4 err)',
  'event IntentExecuted(address indexed eoa,uint256 indexed nonce,bool incremented,bytes4 err)',
]);
type Intent = ReturnType<typeof decodeAbiParameters<typeof INTENT_ABI>>[0];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed recovery data');
  return value as Record<string, unknown>;
}

function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0x[\da-f]+|\d+)$/i.test(value)) throw new Error('Malformed recovery integer');
  const result = BigInt(value);
  if (result >= 2n ** 256n) throw new Error('Recovery integer overflow');
  return result;
}

/** Unknown/pending statuses and any recorded transaction are deliberately ineligible. */
export function requireRejectedFunding(value: unknown, callsId: Hex): Record<string, unknown> {
  const entry = record(value);
  if (!HASH_RE.test(callsId) || entry.id !== callsId || entry.status !== 300
    || !Array.isArray(entry.transactions) || entry.transactions.length !== 0) {
    throw new Error('Recovery requires status 300 with no recorded transactions; do not submit again');
  }
  return entry;
}

export function parseFundingRecovery(value: unknown, account: Address, callsId: Hex, now = Date.now()) {
  if (!ADDRESS_RE.test(account)) throw new Error('Invalid funding account');
  const entry = requireRejectedFunding(value, callsId);
  if (typeof entry.timestamp !== 'number' || !Number.isSafeInteger(entry.timestamp)
    || entry.timestamp * 1_000 > now || now - entry.timestamp * 1_000 > 24 * 60 * 60_000) {
    throw new Error('Recovery only accepts attempts from the last 24 hours');
  }
  const quotes = record(entry.capabilities).quotes;
  if (!Array.isArray(quotes) || quotes.length !== 1) throw new Error('Recovery requires one BSC quote');
  return parseFundingQuote(quotes[0], account, now);
}

export function parseFundingQuote(value: unknown, account: Address, now = Date.now()) {
  const quote = record(value);
  if (uint(quote.chainId) !== 56n || quote.orchestrator !== ALTANA_ORCHESTRATOR_BSC
    || quote.authorizationAddress !== DELEGATION) throw new Error('Unsupported recovery deployment');
  const raw = record(quote.intent);
  const normalized = { ...raw };
  for (const field of INTENT_ABI[0].components) {
    if (field.type === 'uint256') normalized[field.name] = uint(raw[field.name]);
  }
  if (raw.isMultichain !== false) throw new Error('Multichain recovery is not supported');
  // ABI round-trip validates and normalizes every address, integer and byte field.
  const [intent] = decodeAbiParameters(INTENT_ABI, encodeAbiParameters(INTENT_ABI, [normalized as Intent]));
  if (intent.eoa.toLowerCase() !== account.toLowerCase()
    || intent.payer.toLowerCase() !== FUNDING_FEE_PAYER_BSC.toLowerCase()
    || intent.paymentToken !== ZERO || intent.settler !== ZERO || intent.funder !== ZERO
    || intent.funderSignature !== '0x' || intent.settlerContext !== '0x'
    || intent.encodedFundTransfers.length !== 0 || intent.encodedPreCalls.length > 2
    || intent.supportedAccountImplementation.toLowerCase() !== IMPLEMENTATION
    || intent.signature === '0x' || !/^0x[\da-f]{130}$/i.test(intent.paymentSignature)
    || (intent.nonce >> 240n) === 0xc1d0n
    || (intent.expiry !== 0n && intent.expiry <= BigInt(Math.floor(now / 1_000)))
    || intent.paymentAmount <= 0n || intent.paymentAmount > intent.paymentMaxAmount
    || intent.paymentMaxAmount > FUNDING_BOOTSTRAP_FEE_WEI) throw new Error('Unsafe funding recovery intent');
  const gas = uint(quote.txGas);
  if (intent.combinedGas <= 0n || intent.combinedGas >= gas) throw new Error('Invalid recovery gas');
  boundedLegacyFees({ requestedGas: gas, gasPrice: 1n, maxTxFeeWei: FUNDING_BOOTSTRAP_FEE_WEI });
  return { intent, gas, additionalAuthorization: quote.additionalAuthorization };
}

export async function fundingAuthorization(value: unknown, expected: Address): Promise<SignedAuthorization> {
  const raw = record(value);
  const chainId = Number(uint(raw.chainId));
  const nonce = Number(uint(raw.nonce));
  const yParity = Number(uint(raw.yParity));
  if ((chainId !== 0 && chainId !== 56) || !Number.isSafeInteger(nonce)
    || (yParity !== 0 && yParity !== 1) || raw.address !== DELEGATION
    || typeof raw.r !== 'string' || !HASH_RE.test(raw.r)
    || typeof raw.s !== 'string' || !HASH_RE.test(raw.s)
    || BigInt(raw.s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) {
    throw new Error('Invalid funding delegation authorization');
  }
  const authorization = { address: DELEGATION, chainId, nonce, yParity, r: raw.r, s: raw.s } as SignedAuthorization;
  if ((await recoverAuthorizationAddress({ authorization })).toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Funding delegation signer does not match the expected account');
  }
  return authorization;
}

export async function relayRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RELAY, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params.length ? { params } : {}) }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Relay read failed (${response.status})`);
  const body = record(await response.json());
  if (body.error || body.result === undefined) throw new Error('Relay read unavailable; recovery stopped');
  return body.result;
}

async function rejectedHistory(account: Address, callsId: Hex) {
  // Only the latest attempt is eligible: older signed funding must not race a newer deposit.
  const history = await relayRpc('wallet_getCallsHistory', [{ address: account, index: 0, limit: 1, sort: 'desc' }]);
  if (!Array.isArray(history) || history.length !== 1) throw new Error('Funding history unavailable');
  const entry = requireRejectedFunding(history[0], callsId);
  const status = record(await relayRpc('wallet_getCallsStatus', [callsId]));
  if (status.id !== callsId || status.status !== 300 || !Array.isArray(status.receipts) || status.receipts.length) {
    throw new Error('Funding status changed or is uncertain; recovery stopped');
  }
  return entry;
}

export async function prepareFundingRecovery(args: {
  client: PublicClient;
  sender: Address;
  recovery: ReturnType<typeof parseFundingRecovery>;
  userAuthorization: unknown;
}) {
  const { client, recovery, sender } = args;
  const { intent, gas } = recovery;
  if (!ADDRESS_RE.test(sender) || sender === ZERO
    || [intent.eoa, intent.payer].some((address) => address.toLowerCase() === sender.toLowerCase())) {
    throw new Error('Use a separate, dedicated recovery gas wallet');
  }
  if (await client.getChainId() !== 56) throw new Error('Recovery RPC must be BSC chain 56');
  const request = fundingRequestFromExecution(intent.executionData);
  await requireReimbursedFundingRequest(client, { ...request, from: intent.eoa });
  const authorizationList = [];
  for (const [address, value] of [[intent.payer, recovery.additionalAuthorization], [intent.eoa, args.userAuthorization]] as const) {
    const code = await client.getCode({ address });
    if (code && code !== '0x') {
      // A payer used by an earlier activation already has code. Do not re-apply its setup.
      if (address === intent.payer && code.toLowerCase() === `0xef0100${DELEGATION.slice(2)}`) continue;
      throw new Error('Recovery only supports untouched first-activation accounts');
    }
    const authorization = await fundingAuthorization(value, address);
    if (await client.getTransactionCount({ address, blockTag: 'pending' }) !== authorization.nonce) {
      throw new Error('Funding authorization nonce changed; recovery stopped');
    }
    authorizationList.push(authorization);
  }
  const latestNonce = await client.getTransactionCount({ address: sender, blockTag: 'latest' });
  const nonce = await client.getTransactionCount({ address: sender, blockTag: 'pending' });
  const senderCode = await client.getCode({ address: sender });
  if (nonce !== latestNonce || (senderCode && senderCode !== '0x')) {
    throw new Error('Recovery gas wallet must be undelegated with no pending transactions');
  }
  const gasPrice = await client.getGasPrice();
  boundedLegacyFees({ requestedGas: gas, gasPrice, maxTxFeeWei: intent.paymentAmount });
  if (await client.getBalance({ address: sender }) < gas * gasPrice) throw new Error('Recovery gas wallet needs BNB');
  const data = encodeFunctionData({ abi: ORCHESTRATOR_ABI, functionName: 'execute', args: [
    encodeAbiParameters(INTENT_ABI, [{ ...intent, paymentRecipient: sender }]),
  ] });
  const transaction = {
    chainId: 56, type: 'eip7702' as const, to: ALTANA_ORCHESTRATOR_BSC, value: 0n,
    data, nonce, gas, maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice, authorizationList,
  };
  // No state overrides: simulate the exact envelope that would be signed.
  const result = await client.call({ account: sender, ...transaction });
  if (result.data !== `0x${'00'.repeat(32)}`) throw new Error(`Funding simulation rejected (${result.data?.slice(0, 10) ?? 'no result'})`);
  return transaction;
}

/** A successful EVM receipt alone does not mean Orchestrator accepted the intent. */
export function fundingReceiptStatus(receipt: Pick<TransactionReceipt, 'status' | 'logs'>, account: Address, nonce: bigint) {
  if (receipt.status !== 'success') return 'failed';
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ALTANA_ORCHESTRATOR_BSC.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: ORCHESTRATOR_ABI, ...log });
      if (event.args.eoa.toLowerCase() === account.toLowerCase() && event.args.nonce === nonce) {
        return event.args.incremented && event.args.err === '0x00000000' ? 'confirmed' : 'failed';
      }
    } catch { /* unrelated event */ }
  }
  return 'unknown';
}

/** Save signed bytes before any send; even an ambiguous RPC failure cannot cause re-signing. */
export async function submitSavedFunding(args: {
  file: string; callsId: Hex; account: Address; sender: Address;
  sign: () => Promise<Hex>; send: (serializedTransaction: Hex) => Promise<Hex>;
}) {
  let saved: { callsId: Hex; account: Address; sender: Address; raw: Hex; hash: Hex };
  if (existsSync(args.file)) {
    saved = JSON.parse(readFileSync(args.file, 'utf8'));
    if (saved.callsId !== args.callsId || saved.account !== args.account || saved.sender !== args.sender) {
      throw new Error('Recovery journal belongs to another submission');
    }
  } else {
    const raw = await args.sign();
    saved = { callsId: args.callsId, account: args.account, sender: args.sender, raw, hash: keccak256(raw) };
    writeStateFile(args.file, JSON.stringify(saved));
  }
  const transaction = parseTransaction(saved.raw);
  if (keccak256(saved.raw) !== saved.hash || transaction.chainId !== 56 || (transaction.value ?? 0n) !== 0n
    || transaction.to?.toLowerCase() !== ALTANA_ORCHESTRATOR_BSC.toLowerCase()
    || (await recoverTransactionAddress({ serializedTransaction: saved.raw as TransactionSerialized })).toLowerCase() !== args.sender.toLowerCase()) {
    throw new Error('Invalid recovery journal; stop and inspect it');
  }
  try {
    if (await args.send(saved.raw) !== saved.hash) throw new Error('RPC returned a different transaction hash');
  } catch (error) {
    if (knownRawTransactionHash('eth_sendRawTransaction', [saved.raw], error) !== saved.hash) {
      throw new Error(`Submission uncertain. Check saved transaction ${saved.hash}; do not create another funding attempt.`);
    }
  }
  return saved.hash;
}

async function main() {
  const [account, callsId, sender, ...flags] = process.argv.slice(2);
  if (!account || !ADDRESS_RE.test(account) || !callsId || !HASH_RE.test(callsId)
    || !sender || !ADDRESS_RE.test(sender) || flags.some((flag) => flag !== '--broadcast')) {
    throw new Error('Usage: tsx src/recover-funding.ts ACCOUNT CALLS_ID DEDICATED_GAS_WALLET [--broadcast]');
  }
  const rpc = process.env.FUNDING_RECOVERY_RPC ?? PUBLIC_RPC;
  const url = new URL(rpc);
  if (rpc !== PUBLIC_RPC && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Signed funding may only be simulated on the approved BSC RPC or a loopback fork');
  }
  const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 30_000, retryCount: 0 }) });
  const dir = rpc === PUBLIC_RPC ? DATA_DIR : join(DATA_DIR, 'funding-recovery-local');
  ensureDataDir(dir);
  // ponytail: one operator recovery at a time; a stale lock requires manual inspection, never auto-clear.
  const lock = join(dir, 'funding-recovery.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    // ponytail: one retained recovery journal blocks every new attempt until operator review.
    const file = join(dir, 'funding-recovery.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { callsId: Hex; account: Address; sender: Address; hash: Hex; raw: Hex };
      if (saved.callsId !== callsId || saved.account.toLowerCase() !== account.toLowerCase()
        || saved.sender.toLowerCase() !== sender.toLowerCase()) {
        throw new Error(`An earlier recovery is retained (${saved.hash}). Inspect its receipt before any new attempt.`);
      }
      if (!HASH_RE.test(saved.hash) || keccak256(saved.raw) !== saved.hash) throw new Error('Corrupt recovery journal');
      const receipt = await client.getTransactionReceipt({ hash: saved.hash }).catch((error: unknown) => {
        if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
        throw error;
      });
      const tx = parseTransaction(saved.raw);
      const decoded = decodeAbiParameters(INTENT_ABI, decodeExecuteData(tx.data!)[0]);
      console.log({ transactionHash: saved.hash, status: receipt ? fundingReceiptStatus(receipt, account as Address, decoded[0].nonce) : 'pending-or-unknown' });
      return; // Retries are status-only, including after timeouts. No new signature or deposit.
    }
    const recovery = parseFundingRecovery(await rejectedHistory(account as Address, callsId as Hex), account as Address, callsId as Hex);
    const authorization = record(await relayRpc('wallet_getAuthorization', [{ address: account }])).authorization;
    const transaction = await prepareFundingRecovery({ client, sender: sender as Address, recovery, userAuthorization: authorization });
    console.log({ mode: 'simulation', success: true, account, gas: String(transaction.gas), maximumGasCostWei: String(transaction.gas * transaction.maxFeePerGas) });
    if (!flags.includes('--broadcast')) return;
    const keyFile = process.env.FUNDING_RECOVERY_KEY_FILE;
    if (!keyFile) throw new Error('Broadcast requires FUNDING_RECOVERY_KEY_FILE for the dedicated gas wallet');
    const key = record(JSON.parse(readFileSync(resolve(keyFile), 'utf8'))).privateKey;
    if (typeof key !== 'string' || !HASH_RE.test(key)) throw new Error('Invalid recovery key file');
    const signer = privateKeyToAccount(key as Hex);
    if (signer.address.toLowerCase() !== sender.toLowerCase()) throw new Error('Recovery key does not match the gas wallet');
    await rejectedHistory(account as Address, callsId as Hex);
    const hash = await submitSavedFunding({
      file, callsId: callsId as Hex, account: account as Address, sender: sender as Address,
      sign: () => signer.signTransaction(transaction),
      send: (serializedTransaction) => client.sendRawTransaction({ serializedTransaction }),
    });
    console.log({ transactionHash: hash, status: 'submitted; rerun this command to check the receipt' });
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function decodeExecuteData(data: Hex): readonly [Hex] {
  if (!data.startsWith('0x09c5eabe')) throw new Error('Invalid saved recovery calldata');
  return decodeAbiParameters(parseAbiParameters('bytes'), `0x${data.slice(10)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Never print RPC request bodies: they contain still-executable user signatures.
    console.error(error instanceof Error ? error.message.split('\n')[0] : 'Funding recovery failed');
    process.exitCode = 1;
  });
}
