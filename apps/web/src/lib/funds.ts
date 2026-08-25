import 'server-only';

import { BSC_MAINNET } from '@agripinaa/shared';
import { ROUTER_ACTIONS, routerFor, type RouterDeployment } from '@agripinaa/shared/contracts';
import { cacheLife } from 'next/cache';
import { createPublicClient, erc20Abi, fallback, http, parseAbi, parseAbiItem, type Hex } from 'viem';
import { bsc } from 'viem/chains';

/**
 * Public, router-wide view of the managed-yield deployments: what the accounts
 * this router rotates are holding right now, and every Rotated event it has
 * emitted. `lib/managed.ts` reads the same event for ONE connected account and
 * runs in the browser; this module is the server-side, no-wallet-needed twin,
 * so /funds can show the whole picture to a visitor who has connected nothing.
 */

/** Latest-state reads (balances). The public dataseeds answer these. */
const stateClient = createPublicClient({
  chain: bsc,
  transport: fallback(BSC_MAINNET.rpcUrls.map((u) => http(u))),
});

/**
 * Historical getLogs needs an endpoint that keeps the receipts around AND lets
 * a query span enough blocks to cover a whole deployment: the public dataseeds
 * answer "limit exceeded" or "archive requests require a personal token" for
 * anything but the recent head, and a 5000-block cap turns this scan into
 * hundreds of round trips.
 *
 * Each endpoint therefore carries its own span cap, which rules out one viem
 * `fallback` over all of them (a fallback sends every transport the same block
 * range). They are tried in order instead, widest span first. NodeReal's entry
 * is the public BNB Chain endpoint published in the chain's own RPC docs, not a
 * credential of ours; the two behind it are what lib/managed.ts scans with per
 * account. That module is a client module (it pulls in the Altana SDK), so the
 * list is redeclared here rather than imported.
 */
const LOG_SOURCES = [
  { url: 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3', maxSpan: BigInt(50000) },
  { url: 'https://bsc.drpc.org', maxSpan: BigInt(9000) },
  { url: 'https://1rpc.io/bnb', maxSpan: BigInt(9000) },
].map((source) => ({
  maxSpan: source.maxSpan,
  // One retry, so a rate-limited endpoint hands over to the next quickly
  // instead of backing off three times on every chunk of the scan.
  client: createPublicClient({ chain: bsc, transport: http(source.url, { retryCount: 1 }) }),
}));

const ROTATED_EVENT = parseAbiItem(
  'event Rotated(address indexed account, bytes4 indexed action, uint256 usdtAmount)',
);
const vTokenReadAbi = parseAbi(['function balanceOfUnderlying(address owner) view returns (uint256)']);

const ACTION_LABEL: Record<string, string> = {
  [ROUTER_ACTIONS.toAave.selector]: 'Moved into Aave',
  [ROUTER_ACTIONS.toVenus.selector]: 'Moved into Venus',
  [ROUTER_ACTIONS.toIdle.selector]: 'Unwound to idle',
};

/** Ceiling on one scan. Past that the page states the floor it reached. */
const MAX_CHUNKS = 120;
/** Chunks in flight at once. Enough to be quick, low enough to stay served. */
const CHUNK_CONCURRENCY = 6;
/** Wall clock budget for the whole scan, so a slow endpoint cannot hang a render. */
const SCAN_DEADLINE_MS = 20_000;

/** The shape of a viem Rotated log this module reads, and nothing more. */
export interface RotationLogLike {
  args: { account?: string; action?: string; usdtAmount?: bigint };
  transactionHash: string | null;
  blockNumber: bigint | null;
  logIndex: number | null;
}

/** One row of the public rotation table. Strings only: this crosses `use cache`. */
export interface RotationRow {
  account: string;
  action: string;
  amount: string;
  txHash: string;
  blockNumber: string;
  /** Position within the block, so two rotations in one transaction stay distinct. */
  logIndex: number;
  /** ISO timestamp of the block, or null when the block could not be dated. */
  at: string | null;
}

export interface RouterFunds {
  symbol: string;
  /**
   * Totals across every account this router has rotated: `deployed` is their
   * aToken plus Venus balances, `idle` is the plain stablecoin sitting in the
   * accounts, `total` is the sum. Null when the account set could not be read.
   */
  managed: { total: string; deployed: string; idle: string; accounts: number } | null;
  /** Stablecoin value the router contract itself holds. Expected to be 0.00. */
  custody: string | null;
  /** Null when the log scan failed, empty when the router has never rotated. */
  rotations: RotationRow[] | null;
  scannedFrom: string | null;
  scannedTo: string | null;
  asOf: string;
}

/** Thousands separators for an already-rendered digit string. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format 18-decimal base units as a grouped, 2-decimal string. Done in bigint
 * and with an explicit separator rather than toLocaleString, which groups by
 * whatever ICU locale the host happens to run under (1 234,57 on a French dev
 * box, 1,234.57 on Vercel) and loses precision above 2^53 base units.
 */
export function formatStableAmount(value: bigint, decimals = 18): string {
  const negative = value < BigInt(0);
  const magnitude = negative ? -value : value;
  const unit = BigInt(10) ** BigInt(decimals);
  let whole = magnitude / unit;
  // Round half up at the cent, so 0.005 shows as 0.01 and dust shows as 0.00.
  let cents = ((magnitude % unit) * BigInt(100) + unit / BigInt(2)) / unit;
  if (cents === BigInt(100)) {
    whole += BigInt(1);
    cents = BigInt(0);
  }
  return `${negative ? '-' : ''}${groupDigits(whole.toString())}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Turn raw Rotated logs into display rows, newest first. Split out from the
 * scan so the decoding is testable without an RPC.
 */
export function decodeRotationRows(
  logs: RotationLogLike[],
  secondsByBlock: Map<bigint, number>,
): RotationRow[] {
  return [...logs]
    .sort((a, b) => {
      const blockA = a.blockNumber ?? BigInt(0);
      const blockB = b.blockNumber ?? BigInt(0);
      if (blockA !== blockB) return blockB > blockA ? 1 : -1;
      return (b.logIndex ?? 0) - (a.logIndex ?? 0);
    })
    .map((log) => {
      const block = log.blockNumber ?? BigInt(0);
      const seconds = secondsByBlock.get(block);
      return {
        account: log.args.account ?? '',
        action: ACTION_LABEL[(log.args.action ?? '').toLowerCase()] ?? 'Rotation',
        amount: formatStableAmount(log.args.usdtAmount ?? BigInt(0)),
        txHash: log.transactionHash ?? '',
        blockNumber: block.toString(),
        logIndex: log.logIndex ?? 0,
        at: seconds != null ? new Date(seconds * 1000).toISOString() : null,
      };
    });
}

/** Idle stablecoin plus venue balances an address holds, in stablecoin units. */
async function readPosition(router: RouterDeployment, holder: Hex) {
  const [idle, aTokens, venusUnderlying] = await Promise.all([
    stateClient.readContract({ address: router.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }),
    stateClient.readContract({ address: router.aUsdt, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }),
    stateClient.readContract({
      address: router.vUsdt,
      abi: vTokenReadAbi,
      functionName: 'balanceOfUnderlying',
      args: [holder],
    }),
  ]);
  return { idle, deployed: aTokens + venusUnderlying };
}

type LogSource = (typeof LOG_SOURCES)[number];

/**
 * Every Rotated event this router has emitted, with no account filter. Chunked
 * because the endpoints cap a query's block span, batched because they also cap
 * requests in flight, and it rejects rather than dropping a chunk: a page
 * claiming to list a router's history must not quietly list part of it.
 */
async function scanOneSource(router: RouterDeployment, source: LogSource, deadline: number) {
  const latest = await source.client.getBlockNumber();
  const reach = source.maxSpan * BigInt(MAX_CHUNKS);
  const floor = latest - reach > router.deployBlock ? latest - reach : router.deployBlock;
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let block = floor; block <= latest; block += source.maxSpan) {
    const to = block + source.maxSpan - BigInt(1);
    ranges.push({ from: block, to: to > latest ? latest : to });
  }
  const logs: RotationLogLike[] = [];
  for (let i = 0; i < ranges.length; i += CHUNK_CONCURRENCY) {
    if (Date.now() > deadline) throw new Error('rotation log scan ran out of time');
    const batch = await Promise.all(
      ranges.slice(i, i + CHUNK_CONCURRENCY).map((range) =>
        source.client.getLogs({
          address: router.address,
          event: ROTATED_EVENT,
          fromBlock: range.from,
          toBlock: range.to,
        }),
      ),
    );
    for (const chunk of batch) logs.push(...(chunk as unknown as RotationLogLike[]));
  }
  return { logs, floor, latest, client: source.client };
}

/** The first log source that answers a whole scan, widest block span first. */
async function scanRotations(router: RouterDeployment) {
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  let lastError: unknown = new Error('no log source configured');
  for (const source of LOG_SOURCES) {
    try {
      return await scanOneSource(router, source, deadline);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Block timestamps for the handful of blocks that carry a rotation. */
async function datesFor(
  logs: RotationLogLike[],
  client: LogSource['client'],
): Promise<Map<bigint, number>> {
  const blocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
  const secondsByBlock = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber });
        secondsByBlock.set(blockNumber, Number(block.timestamp));
      } catch {
        /* leave the row undated rather than dropping it */
      }
    }),
  );
  return secondsByBlock;
}

/**
 * The public picture of one router deployment. Every failure degrades to null
 * on its own field: an RPC outage still leaves the page its addresses and its
 * security notes, which is what most of /funds is.
 */
export async function readRouterFunds(symbol: string): Promise<RouterFunds> {
  'use cache';
  cacheLife('minutes');
  const asOf = new Date().toISOString();
  const empty: RouterFunds = {
    symbol,
    managed: null,
    custody: null,
    rotations: null,
    scannedFrom: null,
    scannedTo: null,
    asOf,
  };
  const router = routerFor(BSC_MAINNET.id, symbol);
  if (!router) return empty;

  const custody = await readPosition(router, router.address)
    .then((p) => formatStableAmount(p.idle + p.deployed))
    .catch(() => null);

  let scan: Awaited<ReturnType<typeof scanRotations>>;
  try {
    scan = await scanRotations(router);
  } catch {
    return { ...empty, custody };
  }

  const rotations = decodeRotationRows(scan.logs, await datesFor(scan.logs, scan.client));
  const accounts = [...new Set(rotations.map((r) => r.account.toLowerCase()).filter(Boolean))] as Hex[];
  const managed = await Promise.all(accounts.map((account) => readPosition(router, account)))
    .then((positions) => {
      const idle = positions.reduce((sum, p) => sum + p.idle, BigInt(0));
      const deployed = positions.reduce((sum, p) => sum + p.deployed, BigInt(0));
      return {
        total: formatStableAmount(idle + deployed),
        deployed: formatStableAmount(deployed),
        idle: formatStableAmount(idle),
        accounts: accounts.length,
      };
    })
    .catch(() => null);

  return {
    symbol,
    managed,
    custody,
    rotations,
    scannedFrom: scan.floor.toString(),
    scannedTo: scan.latest.toString(),
    asOf,
  };
}
