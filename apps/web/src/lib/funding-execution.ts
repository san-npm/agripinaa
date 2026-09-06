'use client';

import { BNB, createClient, type ClientExecuteOptions } from '@altananetwork/sdk';
import { directFundingId, directFundingNonce } from '@agripinaa/shared/funding';
import { toHex, type Address } from 'viem';
import { altanaClient } from './altana';

/** Choose the sender before signing. A selected direct submission never falls back to Altana. */
export async function executeFunding(options: ClientExecuteOptions) {
  if (!options.merchantUrl || !('wallet' in options) || options.chainId !== 56) {
    return altanaClient().execute(options);
  }
  const response = await fetch('/api/funding/relay', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agripinaa_getFundingMode', params: [options.wallet.address] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Funding sender is unavailable. Nothing was signed; please try again later.');
  const body = await response.json() as { result?: { enabled?: unknown } };
  if (typeof body.result?.enabled !== 'boolean') throw new Error('Funding sender returned an invalid configuration');
  if (!body.result.enabled) return altanaClient().execute(options);
  if (!options.onSubmitted) throw new Error('Direct funding requires a durable checkpoint');
  const nonce = directFundingNonce(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const id = directFundingId(options.wallet.address as Address, nonce);
  const client = createClient({ chains: [{ ...BNB, relayUrl: new URL('/api/funding/relay', window.location.origin).href }], defaultChainId: 56 });
  let checkpointStarted = false;
  try {
    return await client.execute({ ...options, nonce,
      onBeforeSubmit: () => {
        checkpointStarted = true;
        return options.onSubmitted!(id);
      },
      onSubmitted: (returnedId) => {
        if (returnedId !== id) throw new Error('Funding response could not be matched. Check the saved funding status before retrying.');
      },
    });
  } catch {
    // viem errors embed the full request, including executable passkey/fee signatures.
    throw new Error(checkpointStarted
      ? 'Funding was not confirmed. Use “Check funding status” before retrying; do not deposit again.'
      : 'Funding preparation stopped before submission. Refresh the quote and try again.');
  }
}
