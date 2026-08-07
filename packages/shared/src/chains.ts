export const BSC_MAINNET = {
  id: 56,
  name: 'BNB Chain',
  rpcUrls: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.bnbchain.org',
  ],
  explorer: 'https://bscscan.com',
} as const;

export const BSC_TESTNET = {
  id: 97,
  name: 'BSC Testnet',
  rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'],
  explorer: 'https://testnet.bscscan.com',
} as const;

/**
 * ERC-8004 registry deployments (deterministic 0x8004… CREATE2 addresses).
 * ERC-8004 is still a Draft EIP; ABIs are pinned in this repo rather than
 * fetched, so a spec revision cannot silently change behavior.
 * No ValidationRegistry is deployed on any chain: trust surfaces are
 * reputation-only until that changes.
 */
export const ERC8004_REGISTRIES: Record<
  number,
  { identity: `0x${string}`; reputation: `0x${string}` }
> = {
  56: {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  },
  97: {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
};

/** Minimal pinned ABI for the ERC-8004 IdentityRegistry (ERC-721 based). */
export const IDENTITY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'URIUpdated',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'newURI', type: 'string', indexed: false },
      { name: 'updatedBy', type: 'address', indexed: true },
    ],
  },
] as const;

export function bscScanTx(chainId: number, txHash: string): string {
  const base = chainId === 97 ? BSC_TESTNET.explorer : BSC_MAINNET.explorer;
  return `${base}/tx/${txHash}`;
}

export function bscScanAddress(chainId: number, address: string): string {
  const base = chainId === 97 ? BSC_TESTNET.explorer : BSC_MAINNET.explorer;
  return `${base}/address/${address}`;
}
