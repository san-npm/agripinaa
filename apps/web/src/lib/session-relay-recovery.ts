'use client';

import type { Address, Hex } from 'viem';

const ALTANA_RELAY_URL = 'https://relay.altana.network';
const CALLS_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const PUBLIC_KEY_RE = /^0x04[0-9a-fA-F]{128}$/;

export interface RelaySessionGrant {
  callsId: Hex;
  status: 'pending' | 'confirmed';
  transactionHash?: Hex;
}

export interface RelayCallStatus {
  callsId: Hex;
  status: 'pending' | 'confirmed' | 'failed';
  transactionHash?: Hex;
}

export function parseRelayCallStatus(value: unknown, callsId: Hex): RelayCallStatus {
  if (!CALLS_ID_RE.test(callsId)) throw new Error('Invalid relay call id.');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The relay returned an unreadable call status.');
  }
  const result = (value as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('The relay returned an unreadable call status.');
  }
  const entry = result as { id?: unknown; status?: unknown; receipts?: unknown };
  if (
    typeof entry.id !== 'string'
    || !CALLS_ID_RE.test(entry.id)
    || entry.id.toLowerCase() !== callsId.toLowerCase()
    || (typeof entry.status !== 'number' && typeof entry.status !== 'string')
  ) {
    throw new Error('The relay returned an unreadable call status.');
  }
  const receipt = Array.isArray(entry.receipts)
    ? entry.receipts.find((candidate) => typeof candidate === 'object' && candidate !== null) as {
      status?: unknown;
      transactionHash?: unknown;
    } | undefined
    : undefined;
  const transactionHash = typeof receipt?.transactionHash === 'string'
    && CALLS_ID_RE.test(receipt.transactionHash)
    ? receipt.transactionHash as Hex
    : undefined;
  const relayConfirmed = entry.status === 200 || entry.status === 'CONFIRMED';
  const status = entry.status === 500
    || entry.status === 'FAILED'
    || (relayConfirmed && receipt?.status === '0x0')
    ? 'failed'
    : relayConfirmed && transactionHash
      ? 'confirmed'
      : 'pending';
  return {
    callsId,
    status,
    ...(transactionHash ? { transactionHash } : {}),
  };
}

/** Read one saved relay submission without entering the SDK's four-minute wait. */
export async function readRelayCallStatus(args: {
  callsId: Hex;
  fetcher?: typeof fetch;
}): Promise<RelayCallStatus> {
  const fetcher = args.fetcher ?? fetch;
  const response = await fetcher(ALTANA_RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'wallet_getCallsStatus',
      params: [args.callsId],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`The relay status check failed (${response.status}).`);
  }
  return parseRelayCallStatus(await response.json(), args.callsId);
}

/**
 * Find an account-wide relay submission containing this exact manager key.
 * This is deliberately independent of browser storage: it closes the retry
 * gap when the first tab/device lost its local checkpoint after submission.
 */
export function parseRelaySessionGrant(
  value: unknown,
  account: Address,
  publicKey: Hex,
): RelaySessionGrant | null {
  if (!PUBLIC_KEY_RE.test(publicKey)) throw new Error('Invalid manager public key.');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The relay returned an unreadable call history.');
  }
  const result = (value as { result?: unknown }).result;
  if (!Array.isArray(result)) throw new Error('The relay returned an unreadable call history.');

  const accountNeedle = account.toLowerCase();
  const keyNeedle = publicKey.slice(2).toLowerCase();
  for (const item of result.slice(0, 25)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const entry = item as {
      id?: unknown;
      status?: unknown;
      capabilities?: unknown;
      transactions?: unknown;
    };
    if (entry.status === 500 || typeof entry.status !== 'number') continue;
    if (typeof entry.id !== 'string' || !CALLS_ID_RE.test(entry.id)) continue;
    const quotes = (entry.capabilities as { quotes?: unknown } | null)?.quotes;
    if (!Array.isArray(quotes)) continue;
    const exactGrant = quotes.some((quote) => {
      if (typeof quote !== 'object' || quote === null || Array.isArray(quote)) return false;
      const candidate = quote as { chainId?: unknown; intent?: unknown };
      const chainId = candidate.chainId;
      if (chainId !== 56 && chainId !== '56' && chainId !== '0x38') return false;
      const intent = candidate.intent as { eoa?: unknown; executionData?: unknown } | null;
      return typeof intent?.eoa === 'string'
        && intent.eoa.toLowerCase() === accountNeedle
        && typeof intent.executionData === 'string'
        && intent.executionData.toLowerCase().includes(keyNeedle);
    });
    if (exactGrant) {
      const transaction = Array.isArray(entry.transactions)
        ? entry.transactions.find((candidate) => {
          if (typeof candidate !== 'object' || candidate === null) return false;
          const chainId = (candidate as { chainId?: unknown }).chainId;
          return chainId === 56 || chainId === '56' || chainId === '0x38';
        }) as { transactionHash?: unknown } | undefined
        : undefined;
      const transactionHash = typeof transaction?.transactionHash === 'string'
        && CALLS_ID_RE.test(transaction.transactionHash)
        ? transaction.transactionHash as Hex
        : undefined;
      return {
        callsId: entry.id as Hex,
        status: entry.status === 200 ? 'confirmed' : 'pending',
        ...(transactionHash ? { transactionHash } : {}),
      };
    }
  }
  return null;
}

export async function findRelaySessionGrant(args: {
  account: Address;
  publicKey: Hex;
  fetcher?: typeof fetch;
}): Promise<RelaySessionGrant | null> {
  const fetcher = args.fetcher ?? fetch;
  const pageSize = 25;
  let index = 0;
  // A session is capped at 30 days. Scan every account call in that window;
  // hitting the hard bound is uncertainty and therefore blocks a new grant.
  const oldestRelevant = Math.floor(Date.now() / 1_000) - 31 * 24 * 60 * 60;
  for (let page = 0; page < 40; page += 1) {
    const response = await fetcher(ALTANA_RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: page + 1,
        method: 'wallet_getCallsHistory',
        params: [{ address: args.account, index, limit: pageSize, sort: 'desc' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`The relay call-history check failed (${response.status}). Activation stopped before granting.`);
    }
    const body = await response.json();
    const grant = parseRelaySessionGrant(body, args.account, args.publicKey);
    if (grant) {
      const status = await readRelayCallStatus({ callsId: grant.callsId, fetcher });
      if (status.status === 'failed') return null;
      return {
        callsId: status.callsId,
        status: status.status,
        ...(status.transactionHash ? { transactionHash: status.transactionHash } : {}),
      };
    }
    const entries = (body as { result?: unknown }).result;
    if (!Array.isArray(entries)) throw new Error('The relay returned an unreadable call history.');
    if (entries.length < pageSize) return null;
    const cursors = entries.map((entry) => {
      if (typeof entry !== 'object' || entry === null) throw new Error('The relay returned an unreadable call-history cursor.');
      const { index: entryIndex, timestamp } = entry as { index?: unknown; timestamp?: unknown };
      if (!Number.isSafeInteger(entryIndex) || !Number.isSafeInteger(timestamp)) {
        throw new Error('The relay returned an unreadable call-history cursor.');
      }
      return { index: entryIndex as number, timestamp: timestamp as number };
    });
    if (cursors.every((cursor) => cursor.timestamp < oldestRelevant)) return null;
    const nextIndex = Math.max(...cursors.map((cursor) => cursor.index)) + 1;
    if (nextIndex <= index) throw new Error('The relay call-history cursor did not advance.');
    index = nextIndex;
  }
  throw new Error('The relay history is too large to prove that this manager grant is absent. Activation stopped before granting.');
}
