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
  address: '0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  aUsdt: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
  // Deployed 2026-08-20 (~block 117084863 on BSC). A safe floor for log scans.
  deployBlock: BigInt(117084000),
};

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

/** The router deployment for a given chain, or undefined if unmanaged there. */
export function routerFor(chainId: number): RouterDeployment | undefined {
  return chainId === YIELD_ROUTER_BSC.chainId ? YIELD_ROUTER_BSC : undefined;
}
