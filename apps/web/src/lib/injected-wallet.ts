'use client';

import { createWalletClient, custom, type Hex, type WalletClient } from 'viem';

import { bsc } from './bsc-chain';

/**
 * The one place the claim flow talks to a browser wallet.
 *
 * Deliberately viem and nothing else. The rest of the site activates agents
 * through passkey wallets (`SessionWizard`, `ManagedWizard`) and the app has no
 * wagmi provider anywhere in its tree, so pulling one in for a single connect
 * button would mean wrapping the whole app to serve one page. A claim needs
 * exactly two things from a wallet, an address and one EIP-712 signature, and
 * an injected provider gives both directly.
 *
 * Nothing here is persisted: the address lives in the form's state for as long
 * as the page is open, and the signature goes straight to the claim endpoint.
 */

/** Claims are BNB Chain only, matching `CLAIM_CHAIN_ID` on the server. */
export const CLAIM_CHAIN = bsc;

/** No injected provider at all, which is worth saying plainly rather than failing. */
export class NoWalletError extends Error {
  constructor() {
    super('No browser wallet detected. Install a wallet extension, then reload this page.');
  }
}

type Eip1193Provider = Parameters<typeof custom>[0];

/** The injected provider, or null when the browser has none. */
export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const injected = (window as { ethereum?: Eip1193Provider }).ethereum;
  return injected ?? null;
}

export interface InjectedConnection {
  address: Hex;
  client: WalletClient;
}

/**
 * A wallet client on BNB Chain plus the account it selected.
 *
 * The chain is switched rather than assumed: signing a claim whose domain says
 * 56 while the wallet is on another chain is refused by some wallets and
 * silently allowed by others, and the second case produces a signature the
 * server cannot match to anything. A wallet that does not know BNB Chain yet is
 * offered it once (4902 is the EIP-1193 code for an unrecognised chain), which
 * is the only case where adding a chain is the right answer to a switch.
 */
export async function connectInjected(): Promise<InjectedConnection> {
  const provider = injectedProvider();
  if (!provider) throw new NoWalletError();

  const client = createWalletClient({ chain: CLAIM_CHAIN, transport: custom(provider) });
  const [address] = await client.requestAddresses();
  if (!address) throw new Error('The wallet returned no account.');

  if ((await client.getChainId()) !== CLAIM_CHAIN.id) {
    try {
      await client.switchChain({ id: CLAIM_CHAIN.id });
    } catch (error) {
      if (!isUnrecognizedChain(error)) throw error;
      await client.addChain({ chain: CLAIM_CHAIN });
      await client.switchChain({ id: CLAIM_CHAIN.id });
    }
  }

  return { address, client };
}

function isUnrecognizedChain(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === 4902 || causeCode === 4902;
}
