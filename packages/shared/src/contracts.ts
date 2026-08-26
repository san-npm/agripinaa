import { keccak256, type Hex } from 'viem';

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
  /**
   * Debt ledgers checked atomically before a source receipt may move.
   * 0 = none, 2 = Aave aggregate + Venus vToken markets, 3 = also Venus VAI.
   * Only version 3 is complete enough for automated execution.
   */
  debtGuardVersion: number;
  /** keccak256 of deployed runtime bytecode; mandatory before v3 can activate. */
  runtimeCodeHash?: Hex;
}

export const COMPLETE_DEBT_GUARD_VERSION = 3;

export function isDebtCompleteRouter(router: RouterDeployment | undefined): router is RouterDeployment {
  return router != null
    && router.debtGuardVersion >= COMPLETE_DEBT_GUARD_VERSION
    && /^0x[0-9a-fA-F]{64}$/.test(router.runtimeCodeHash ?? '');
}

const ROUTER_VERSION_ABI = [{
  type: 'function',
  name: 'DEBT_GUARD_VERSION',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'uint256' }],
}] as const;

/** Metadata is eligibility only; live bytecode and its version must also attest. */
export async function isDebtCompleteRouterRuntime(
  client: {
    getCode(args: { address: Hex }): Promise<Hex | undefined>;
    readContract(args: {
      address: Hex;
      abi: typeof ROUTER_VERSION_ABI;
      functionName: 'DEBT_GUARD_VERSION';
    }): Promise<unknown>;
  },
  router: RouterDeployment | undefined,
): Promise<boolean> {
  if (!isDebtCompleteRouter(router)) return false;
  try {
    const [code, version] = await Promise.all([
      client.getCode({ address: router.address }),
      client.readContract({ address: router.address, abi: ROUTER_VERSION_ABI, functionName: 'DEBT_GUARD_VERSION' }),
    ]);
    return code != null
      && code !== '0x'
      && keccak256(code).toLowerCase() === router.runtimeCodeHash!.toLowerCase()
      && BigInt(version as bigint) >= BigInt(COMPLETE_DEBT_GUARD_VERSION);
  } catch {
    return false;
  }
}

/** A single RPC may pause activation, but cannot authorize a router alone. */
export async function isDebtCompleteRouterRuntimeQuorum(
  clients: readonly Parameters<typeof isDebtCompleteRouterRuntime>[0][],
  router: RouterDeployment | undefined,
  required = 2,
): Promise<boolean> {
  if (clients.length < required || required < 1) return false;
  const results = await Promise.allSettled(
    clients.map((client) => isDebtCompleteRouterRuntime(client, router)),
  );
  return results.filter((result) => result.status === 'fulfilled' && result.value).length >= required;
}

/**
 * Debt-complete BNB Chain mainnet (56) deployment. It includes delta
 * accounting, Aave aggregate-debt checks, Venus market + VAI debt checks, and
 * constructor binding checks. The runtime hash was independently read through
 * two RPC providers before this deployment was admitted to the manifest.
 */
export const YIELD_ROUTER_BSC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDT',
  address: '0x67c0005C2a9709a28DA42cEC9b11b8a7201B4C22',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  aUsdt: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
  // Created by tx 0xd6501a3deeaf406a50b58bd44383c8d51e9e00ea5f3565a25d15ba6d6fbcd0f8.
  deployBlock: BigInt(118230700),
  deployedOn: '2026-08-26',
  debtGuardVersion: 3,
  runtimeCodeHash: '0xc20d8eb8623f79a688daa29414adc64dddd48634a68f46169cd871105cdd1f16',
};

/**
 * Guarded USDC deployment (same router bytecode, USDC venues).
 * The `usdt`/`aUsdt`/`vUsdt` fields hold the USDC-side addresses (names kept
 * for continuity); `symbol` disambiguates.
 */
export const YIELD_ROUTER_BSC_USDC: RouterDeployment = {
  chainId: 56,
  symbol: 'USDC',
  address: '0x4A2E2817736D8497EeB4296dd5e51ECAeA427f72',
  usdt: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  aUsdt: '0x00901a076785e0906d1028c7d6372d247bec7d61',
  aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  vUsdt: '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8',
  // Created by tx 0x1bb52e4a17ba05292a4fa208ecc7b13efc01a30ecec8363404d421ed9413f0e7.
  deployBlock: BigInt(118230776),
  deployedOn: '2026-08-26',
  debtGuardVersion: 3,
  runtimeCodeHash: '0x07a4f5743bffe23fd40cae068261a1d34b69e9362563c7a97ed5b0a4cb66fe1c',
};

/** Every router eligible for a NEW managed-yield activation. */
export const YIELD_ROUTERS_BSC: RouterDeployment[] = [YIELD_ROUTER_BSC, YIELD_ROUTER_BSC_USDC];

/**
 * Superseded routers. They are intentionally excluded from
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
  debtGuardVersion: 0,
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
  debtGuardVersion: 0,
};

/**
 * Version-2 debt-aware deployments. These cover Aave aggregate debt and
 * ordinary Venus market debt but predate the Venus VAI-ledger guard. Existing
 * account approvals may still point here, so they stay recoverable by owners
 * while remaining ineligible for agent execution.
 */
export const RETIRED_YIELD_ROUTER_V2_BSC: RouterDeployment = {
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
  debtGuardVersion: 2,
};

export const RETIRED_YIELD_ROUTER_V2_BSC_USDC: RouterDeployment = {
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
  debtGuardVersion: 2,
};

export const RETIRED_YIELD_ROUTERS_BSC: RouterDeployment[] = [
  RETIRED_YIELD_ROUTER_V2_BSC,
  RETIRED_YIELD_ROUTER_V2_BSC_USDC,
  RETIRED_YIELD_ROUTER_BSC,
  RETIRED_YIELD_ROUTER_BSC_USDC,
];

/**
 * Older deployments that are too unsafe even for automated owner recovery.
 * They remain denylisted withdrawal destinations so no stablecoin can be sent
 * into their immutable, unsweepable balances by mistake.
 */
export const DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC = [
  '0x841CF14Dfc0A315115EC5C9714c918210447b260',
] as const;

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

/**
 * True for every managed-system contract that must never receive an owner's
 * withdrawal: active/retired routers, all of their venue/token dependencies,
 * and fully decommissioned historical router addresses.
 */
export function isManagedContractAddress(address: string, chainId: number): boolean {
  const lc = address.toLowerCase();
  const deployments = [...YIELD_ROUTERS_BSC, ...RETIRED_YIELD_ROUTERS_BSC];
  if (
    deployments.some(
      (router) =>
        router.chainId === chainId
        && [router.address, router.usdt, router.aUsdt, router.vUsdt, router.aavePool]
          .some((dependency) => dependency.toLowerCase() === lc),
    )
  ) return true;
  return chainId === 56
    && DECOMMISSIONED_YIELD_ROUTER_ADDRESSES_BSC.some((router) => router.toLowerCase() === lc);
}
