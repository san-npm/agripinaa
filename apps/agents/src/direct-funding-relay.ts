import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  directFundingDeadline, directFundingId, directFundingIdDeadline, isDirectFundingId,
  FUNDING_FEE_PAYER_BSC,
} from '@agripinaa/shared';
import { keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Key } from 'porto/viem';
import { ensureDataDir } from './chassis';
import { fundingRequestFromExecution } from './funding-merchant';
import { fundingReceiptStatus, parseFundingQuote, prepareFundingRecovery, relayRpc, submitSavedFunding } from './recover-funding';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid funding request');
  return value as Record<string, unknown>;
}

export function signedDirectFunding(value: unknown, now = Date.now()) {
  const request = object(value);
  const quoteSet = object(object(request.context).quote);
  if (!Array.isArray(quoteSet.quotes) || quoteSet.quotes.length !== 1) throw new Error('One funding quote required');
  const quote = object(quoteSet.quotes[0]);
  const original = object(quote.intent);
  const account = original.eoa;
  if (typeof account !== 'string' || !/^0x[\da-f]{40}$/i.test(account)) throw new Error('Invalid funding account');
  const key = object(request.key);
  const registration = fundingRequestFromExecution(original.executionData as Hex);
  if (key.type !== 'webauthnp256' || key.prehash !== false
    || typeof key.publicKey !== 'string' || key.publicKey.toLowerCase() !== registration.key?.publicKey.toLowerCase()) {
    throw new Error('Funding passkey does not match registration');
  }
  if (typeof request.signature !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(request.signature)) {
    throw new Error('Unsafe funding recovery intent');
  }
  // Porto signCalls leaves main-bundle signatures unwrapped for the relay.
  // The contract needs innerSignature || Key.hash(key) || prehash, not raw WebAuthn bytes.
  const signature = Key.wrapSignature(request.signature as Hex, {
    keyType: 'webauthn-p256', publicKey: key.publicKey as Hex, prehash: false,
  });
  const recovery = parseFundingQuote({ ...quote, intent: {
    ...original, signature, paymentSignature: object(request.capabilities).feeSignature,
  } }, account as Address, now);
  const deadline = directFundingDeadline(recovery.intent.nonce);
  if (deadline <= Math.floor(now / 1000) || deadline > Math.floor(now / 1000) + 360) {
    throw new Error('Funding signature expired; refresh the quote before signing again');
  }
  return { recovery, account: account as Address, id: directFundingId(account as Address, recovery.intent.nonce) };
}

/** Single approved-account pilot; reading status never needs the sending key. */
export function createDirectFundingRelay(opts: {
  client: PublicClient;
  journal: string;
  account?: Address;
  privateKey?: Hex;
  relayRead?: typeof relayRpc;
}) {
  const signer = opts.privateKey ? privateKeyToAccount(opts.privateKey) : undefined;
  if (signer && (!opts.account || !/^0x[\da-f]{40}$/i.test(opts.account)
    || [opts.account, FUNDING_FEE_PAYER_BSC].some((address) => address.toLowerCase() === signer.address.toLowerCase()))) {
    throw new Error('Direct funding requires an approved user and a separate gas-wallet key');
  }
  const lock = `${opts.journal}.lock`;
  type Saved = { callsId: Hex; account: Address; sender: Address; raw: Hex; hash: Hex };
  const saved = (): Saved | null => {
    if (!existsSync(opts.journal)) return null;
    const data = JSON.parse(readFileSync(opts.journal, 'utf8')) as Saved;
    if (!isDirectFundingId(data.callsId) || keccak256(data.raw) !== data.hash) throw new Error('Invalid funding journal');
    return data;
  };
  return async (value: unknown): Promise<unknown> => {
    const rpc = object(value);
    // Porto reads capabilities and verifies the merchant response against the relay's quote signer.
    // These two read-only methods do not prepare or submit anything on the hosted relay.
    if (rpc.method === 'health' && (rpc.params === undefined || (Array.isArray(rpc.params) && rpc.params.length === 0))) {
      return (opts.relayRead ?? relayRpc)('health', []);
    }
    if (rpc.method === 'wallet_getCapabilities' && Array.isArray(rpc.params) && rpc.params.length === 1
      && Array.isArray(rpc.params[0]) && rpc.params[0].length === 1 && rpc.params[0][0] === 56) {
      return (opts.relayRead ?? relayRpc)('wallet_getCapabilities', [[56]]);
    }
    if (!Array.isArray(rpc.params) || rpc.params.length !== 1) throw new Error('One RPC parameter required');
    const parameter = rpc.params[0];
    if (rpc.method === 'agripinaa_getFundingMode') {
      return { enabled: Boolean(signer && opts.account && typeof parameter === 'string'
        && parameter.toLowerCase() === opts.account.toLowerCase()) };
    }
    if (rpc.method === 'wallet_getCallsStatus') {
      if (typeof parameter !== 'string' || !isDirectFundingId(parameter)) throw new Error('Invalid direct funding id');
      const entry = saved();
      const pending = { id: parameter, status: 100, receipts: [] };
      if (!entry || entry.callsId !== parameter) {
        // A request still validating may finish after its deadline. A stale lock fails closed.
        return existsSync(lock) || directFundingIdDeadline(parameter) > Math.floor(Date.now() / 1000)
          ? pending : { ...pending, status: 300 };
      }
      const receipt = await opts.client.getTransactionReceipt({ hash: entry.hash }).catch((error: unknown) => {
        if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
        throw error;
      });
      if (!receipt) return pending;
      if (receipt.transactionHash !== entry.hash) throw new Error('Mismatched funding receipt');
      if (await opts.client.getBlockNumber() < receipt.blockNumber + 2n) return pending;
      // The nonce is encoded in the signed transaction's event, bound to the saved id.
      const events = receipt.logs.filter((log) => log.topics.length >= 3 && log.topics[2]);
      const nonce = events.map((log) => BigInt(log.topics[2]!)).find((nonce) => {
        try { return directFundingId(entry.account, nonce) === entry.callsId; } catch { return false; }
      });
      const status = nonce === undefined ? (receipt.status === 'reverted' ? 'failed' : 'unknown')
        : fundingReceiptStatus(receipt, entry.account, nonce);
      if (status === 'unknown') return pending;
      return { id: parameter, status: status === 'confirmed' ? 201 : 500, receipts: [{
        transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
        blockNumber: toHex(receipt.blockNumber), chainId: '0x38', gasUsed: toHex(receipt.gasUsed),
        status: receipt.status === 'success' ? '0x1' : '0x0',
        // Porto's status schema needs only these fields; viem metadata contains bigint.
        logs: receipt.logs.map(({ address, data, topics }) => ({ address, data, topics })),
      }] };
    }
    if (rpc.method !== 'wallet_sendPreparedCalls') throw new Error('Unsupported funding RPC method');
    if (!signer || !opts.account) throw new Error('Direct funding is not enabled');
    const { recovery, account, id } = signedDirectFunding(parameter);
    if (account.toLowerCase() !== opts.account.toLowerCase()) throw new Error('This funding account is not enabled');
    const previous = saved();
    if (previous) {
      if (previous.callsId === id) return { id }; // Never sign or send again.
      throw new Error('An earlier direct funding attempt must be reviewed before another submission');
    }
    ensureDataDir(dirname(opts.journal));
    // ponytail: one retained transaction and an exclusive lock; widen only after the live pilot.
    const fd = openSync(lock, 'wx', 0o600);
    try {
      if (saved()) throw new Error('A funding transaction is already saved');
      const authorization = object(await (opts.relayRead ?? relayRpc)('wallet_getAuthorization', [{ address: account }])).authorization;
      const transaction = await prepareFundingRecovery({ client: opts.client, sender: signer.address, recovery, userAuthorization: authorization });
      if (directFundingDeadline(recovery.intent.nonce) <= Math.floor(Date.now() / 1000)) {
        throw new Error('Funding quote expired during validation; no transaction submitted');
      }
      // Once durable, return the id even on an ambiguous send error. The status remains pending.
      try {
        await submitSavedFunding({ file: opts.journal, callsId: id, account, sender: signer.address,
          sign: () => signer.signTransaction(transaction),
          send: (serializedTransaction) => opts.client.sendRawTransaction({ serializedTransaction }),
        });
      } catch {
        if (saved()?.callsId !== id) throw new Error('Funding submission stopped before it could be saved');
      }
      return { id };
    } finally { closeSync(fd); unlinkSync(lock); }
  };
}
