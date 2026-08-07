import type { OphisAgentWallet, OphisTypedData } from '@ophis/agent-swap';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { BSC_MAINNET } from '@agripinaa/shared';

/**
 * viem-backed implementation of the 5-method OphisAgentWallet interface
 * (see @ophis/agent-swap): the same adapter the reference agents will use.
 */
export class ViemAgentWallet implements OphisAgentWallet {
  private readonly account: Account;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly chain: Chain;

  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
    this.chain = bsc;
    const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport,
    });
  }

  getAddress(): `0x${string}` {
    return this.account.address;
  }

  getChainId(): number {
    return this.chain.id;
  }

  async readErc20Decimals(token: `0x${string}`): Promise<number> {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'decimals',
    });
  }

  async ensureErc20Allowance(
    token: `0x${string}`,
    spender: `0x${string}`,
    minAtomicAmount: bigint,
  ): Promise<void> {
    const current = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.account.address, spender],
    });
    if (current >= minAtomicAmount) return;

    const hash = await this.walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, minAtomicAmount],
      account: this.account,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`approve tx reverted: ${hash}`);
    }
  }

  async signTypedData(data: OphisTypedData): Promise<`0x${string}`> {
    return this.walletClient.signTypedData({
      account: this.account,
      domain: data.domain,
      types: data.types,
      primaryType: data.primaryType,
      message: data.message,
    } as Parameters<WalletClient['signTypedData']>[0]);
  }
}
