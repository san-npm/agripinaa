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
  /**
   * Block the router's creation transaction landed in, and so the floor for
   * Rotated-event log scans. Located by bisecting `eth_getCode` over an archive
   * endpoint and confirmed against the creation receipt's `contractAddress`;
   * the public dataseeds prune the state that bisection needs, which is why the
   * result is recorded here rather than read back at render time.
   */
  deployBlock: bigint;
  /**
   * The UTC day that creation transaction was mined, ISO `YYYY-MM-DD`. Recorded
   * alongside the block so a page can print the date without an RPC round trip.
   */
  deployedOn: string;
}

/**
 * Guarded BNB Chain mainnet (56) deployment. It includes delta accounting,
 * debt-aware unwind guards, and constructor binding checks. It supersedes the
 * 2026-08-20 build at 0xD18375cA…E3eb.
 */
export const YIELD_ROUTER_BSC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDT',
  address: '0xE69503b265E4320f139A0F7b1A6f1D00fCBd3C02',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  aUsdt: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
  // Created by tx 0xb8d59e133e9cae6499701a25254eb08fa310dda26500c0d4ef8b8d6efd4bf731.
  deployBlock: BigInt(118145573),
  deployedOn: '2026-08-26',
};

/**
 * Guarded USDC deployment (same router bytecode, USDC venues).
 * The `usdt`/`aUsdt`/`vUsdt` fields hold the USDC-side addresses (names kept
 * for continuity); `symbol` disambiguates.
 */
export const YIELD_ROUTER_BSC_USDC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDC',
  address: '0x0DD7B7446D449a8968F0FBf1f9a23bd9f2686167',
  usdt: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  aUsdt: '0x00901a076785e0906d1028c7d6372d247bec7d61',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8',
  // Created by tx 0x79c95b920bc310df5d563dacaab5c94d15648beaed2ad54c618aebd634789fd7.
  deployBlock: BigInt(118145739),
  deployedOn: '2026-08-26',
};

/** Every router eligible for a NEW managed-yield activation. */
export const YIELD_ROUTERS_BSC: RouterDeployment[] = [YIELD_ROUTER_BSC, YIELD_ROUTER_BSC_USDC];

/**
 * Superseded delta-accounting routers. They are intentionally excluded from
 * YIELD_ROUTERS_BSC, routerFor(), and routerByAddress(): no new session and no
 * runner registration may target them after the guarded-router migration.
 *
 * The dashboard still needs their immutable token bindings so an owner whose
 * funds remain in an account-held Aave/Venus position can recover through the
 * exact router that account already approved. Keep these recovery-only.
 */
export const RETIRED_YIELD_ROUTER_BSC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDT',
  address: '0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  aUsdt: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
  deployBlock: BigInt(117050416),
  deployedOn: '2026-08-20',
};

export const RETIRED_YIELD_ROUTER_BSC_USDC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDC',
  address: '0xb0817946B5A30A0A2a3dE1B8202749EBEb664630',
  usdt: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  aUsdt: '0x00901a076785e0906d1028c7d6372d247bec7d61',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8',
  deployBlock: BigInt(117231310),
  deployedOn: '2026-08-21',
};

export const RETIRED_YIELD_ROUTERS_BSC: RouterDeployment[] = [
  RETIRED_YIELD_ROUTER_BSC,
  RETIRED_YIELD_ROUTER_BSC_USDC,
];

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

/** Find an ACTIVE managed router by its deployed address (case-insensitive). */
export function routerByAddress(address: string): RouterDeployment | undefined {
  const lc = address.toLowerCase();
  return YIELD_ROUTERS_BSC.find((r) => r.address.toLowerCase() === lc);
}

/**
 * Find a router the owner may use to recover funds. This is deliberately a
 * separate lookup so activation and the runner cannot accidentally re-admit a
 * retired deployment just because the dashboard can unwind through it.
 */
export function recoveryRouterByAddress(address: string): RouterDeployment | undefined {
  return routerByAddress(address)
    ?? RETIRED_YIELD_ROUTERS_BSC.find((r) => r.address.toLowerCase() === address.toLowerCase());
}

/** Resolve exactly one recovery-capable router from a saved session scope. */
export function recoveryRouterFromAllowlist(
  allowlist: readonly string[],
  chainId: number,
): RouterDeployment | undefined {
  const matches = allowlist
    .map(recoveryRouterByAddress)
    .filter((router): router is RouterDeployment => router?.chainId === chainId);
  return matches.length === 1 ? matches[0] : undefined;
}

/** True only for a superseded deployment that is retained for owner recovery. */
export function isRetiredRouterAddress(address: string): boolean {
  const lc = address.toLowerCase();
  return RETIRED_YIELD_ROUTERS_BSC.some((router) => router.address.toLowerCase() === lc);
}
