import type { OphisAgentWallet, OphisTypedData } from '@ophis/agent-swap';
import { erc20Abi, type PublicClient, type WalletClient, type Account } from 'viem';

/**
 * OphisAgentWallet over the chassis's viem clients: the exact adapter proven
 * in Spike A (WBNB → USDT filled on BSC through the patched agent-swap).
 */
export class ChassisOphisWallet implements OphisAgentWallet {
  constructor(
    private readonly account: Account,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly chainId: number = 56,
  ) {}

  getAddress(): `0x${string}` {
    return this.account.address;
  }

  getChainId(): number {
    return this.chainId;
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
      chain: this.walletClient.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`approve reverted: ${hash}`);
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
