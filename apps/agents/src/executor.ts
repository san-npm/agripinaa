/**
 * The managed-execution seam: turn a stored user session into a bounded
 * "call one of the router's three actions" capability.
 *
 * The agent holds ONE manager private key (wallets/agent-<name>-session.json).
 * Every user granted a session to that key's public half, scoped to the
 * YieldRouter selectors. Here we reconstruct each user's Session with the
 * manager key and expose execute(action) → a single router call from the
 * user's own account. Because the router hardcodes every recipient to the
 * caller, this capability can rotate the user's funds but never divert them.
 */
import {
  ROUTER_ACTIONS,
  routerByAddress,
  routerFor,
  type RouterAction,
  type RouterDeployment,
} from '@agripinaa/shared';
import {
  BNB,
  BNB_TESTNET,
  createClient,
  signerFromPrivateKey,
  type Client,
  type Session,
} from '@altananetwork/sdk';
import type { Hex } from 'viem';

import type { ManagedAccount } from './managed';

export interface ManagedExecutor {
  account: Hex;
  chainId: number;
  /** The router deployment (token + venues) this account is managed through. */
  deployment: RouterDeployment;
  /** Fire one router action from the user's account; resolves to the tx result. */
  execute(action: RouterAction): Promise<{ txHash?: Hex; status: string }>;
}

/** The router a session is scoped to (by its call target), else the chain's default (USDT). */
function deploymentForEntry(entry: ManagedAccount): RouterDeployment | undefined {
  const calls = entry.session.permissions?.calls ?? [];
  for (const call of calls) {
    const to = 'to' in call ? call.to : undefined;
    if (to) {
      const byAddr = routerByAddress(to);
      if (byAddr) return byAddr;
    }
  }
  return routerFor(entry.chainId);
}

/** One client for the whole runner; supports both mainnet and testnet sessions. */
export function createAltanaClient(): Client {
  return createClient({ chains: [BNB, BNB_TESTNET], defaultChainId: 56 });
}

export function managedExecutor(opts: {
  client: Client;
  managerKey: Hex;
  entry: ManagedAccount;
}): ManagedExecutor {
  const { client, managerKey, entry } = opts;
  const router = deploymentForEntry(entry);
  if (!router) throw new Error(`no YieldRouter deployed on chain ${entry.chainId}`);

  const session: Session = {
    walletAddress: entry.session.walletAddress,
    signer: signerFromPrivateKey(managerKey),
    publicKey: entry.session.publicKey,
    permissions: entry.session.permissions,
    expiry: entry.session.expiry,
  };

  return {
    account: entry.account,
    chainId: entry.chainId,
    deployment: router,
    async execute(action) {
      // Zero-argument selectors: the calldata IS the 4-byte selector.
      const data = ROUTER_ACTIONS[action].selector as Hex;
      const result = await client.execute({
        session,
        chainId: entry.chainId,
        calls: [{ to: router.address, data }],
      });
      return { txHash: result.transactionHash, status: result.status };
    },
  };
}
