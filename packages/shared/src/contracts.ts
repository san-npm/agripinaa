/**
 * On-chain contracts Agripinaa agents manage funds through.
 *
 * The YieldRouter is the ONLY contract a managed yield session is scoped to.
 * It is stateless, un-owned, and non-upgradeable: every entrypoint hardcodes
 * the recipient to msg.sender (the user's own smart account), so a scoped
 * session key can rotate the user's funds between venues or back to idle but
 * can never move value to a third party. See contracts/src/AgripinaaYieldRouter.sol.
 */

export interface RouterDeployment {
  chainId: number;
  /** Managed stablecoin symbol, e.g. 'USDT' | 'USDC'. */
  symbol: string;
  /** The deployed AgripinaaYieldRouter. */
  address: `0x${string}`;
  /** Venue + token addresses the router was constructed with (for display/verification). */
  usdt: `0x${string}`;
  aUsdt: `0x${string}`;
  aavePool: `0x${string}`;
  vUsdt: `0x${string}`;
  /** Block the router was deployed at — the floor for Rotated-event log scans. */
  deployBlock: bigint;
}

/**
 * BNB Chain mainnet (56) deployment. Deployed 2026-08-20. This is the
 * delta-accounting build (audit L-1 fix): the router distributes only the
 * funds each call brings in, never any stranded balance. Supersedes the first
 * cut at 0x841CF14D…b260 (which paid out its whole balance).
 */
export const YIELD_ROUTER_BSC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDT',
  address: '0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  aUsdt: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
  // Deployed 2026-08-20 (~block 117084863 on BSC). A safe floor for log scans.
  deployBlock: BigInt(117084000),
};

/**
 * USDC deployment (same router bytecode, USDC venues). Deployed 2026-08-21.
 * The `usdt`/`aUsdt`/`vUsdt` fields hold the USDC-side addresses (names kept
 * for continuity); `symbol` disambiguates.
 */
export const YIELD_ROUTER_BSC_USDC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDC',
  address: '0xb0817946B5A30A0A2a3dE1B8202749EBEb664630',
  usdt: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  aUsdt: '0x00901a076785e0906d1028c7d6372d247bec7d61',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8',
  deployBlock: BigInt(117231000),
};

/** Every managed-yield router deployment. */
export const YIELD_ROUTERS_BSC: RouterDeployment[] = [YIELD_ROUTER_BSC, YIELD_ROUTER_BSC_USDC];

/**
 * Managed stablecoins, in DISPLAY order. This array decides which token button
 * the managed wizard renders first and nothing else. Reordering it is a
 * cosmetic edit and must stay one: see PRIMARY_MANAGED_TOKEN.
 */
export const MANAGED_TOKENS = ['USDT', 'USDC'] as const;
export type ManagedToken = (typeof MANAGED_TOKENS)[number];

/**
 * The managed token whose sessions are granted to the agent's MASTER manager
 * key; every other managed token derives its own key from that master.
 *
 * Declared here, separately from MANAGED_TOKENS, because it is on-chain key
 * identity rather than presentation. The runner used to read MANAGED_TOKENS[0],
 * which coupled the two: swapping the array to put USDC first would have moved
 * the master key from USDT to USDC, and since every live USDT mandate was
 * granted to the master public key, the executor's signer check would then
 * reject all of them and every user's funds would stop being managed. It fails
 * closed on funds, but a button-order edit must not be able to cause it.
 *
 * Changing this value is a migration, not an edit: it needs every affected
 * mandate re-granted to the new key.
 */
export const PRIMARY_MANAGED_TOKEN: ManagedToken = 'USDT';

/**
 * The three (and only three) selectors a managed yield session may call. A
 * session scoped to {router.address} × these selectors is provably drain-proof.
 */
export const ROUTER_ACTIONS = {
  toAave: { signature: 'toAave()', selector: '0xdb1a4d6d' },
  toVenus: { signature: 'toVenus()', selector: '0x88b480df' },
  toIdle: { signature: 'toIdle()', selector: '0x18b5e866' },
} as const;

export type RouterAction = keyof typeof ROUTER_ACTIONS;

/**
 * The router deployment for a chain + managed token (defaults to USDT so
 * existing single-token callers keep working). Undefined if unmanaged.
 */
export function routerFor(chainId: number, symbol: string = 'USDT'): RouterDeployment | undefined {
  return YIELD_ROUTERS_BSC.find((r) => r.chainId === chainId && r.symbol === symbol);
}

/** Find a managed router by its deployed address (case-insensitive). */
export function routerByAddress(address: string): RouterDeployment | undefined {
  const lc = address.toLowerCase();
  return YIELD_ROUTERS_BSC.find((r) => r.address.toLowerCase() === lc);
}
