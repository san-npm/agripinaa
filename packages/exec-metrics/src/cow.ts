/**
 * Typed client for the CoW Protocol orderbook REST API serving BNB Chain.
 * Field names are verified against live responses from the BSC orderbook
 * (see tests/fixtures/order.json and tests/fixtures/trades.json, captured
 * from api.cow.fi/bnb).
 */

import { concatHex, hashTypedData, isAddress, keccak256, numberToHex, toBytes, type Hex } from 'viem';

export type Address = `0x${string}`;

export type OrderKind = 'sell' | 'buy';

/** Order as returned by GET /orders/{uid} and GET /account/{owner}/orders. */
export interface CowOrder {
  uid: string;
  owner: string;
  status: string;
  kind: OrderKind;
  sellToken: string;
  buyToken: string;
  /** Signed sell amount, base units. */
  sellAmount: string;
  /** Signed buy amount (the limit), base units. */
  buyAmount: string;
  receiver: string;
  feeAmount: string;
  partiallyFillable: boolean;
  sellTokenBalance: string;
  buyTokenBalance: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  executedFeeAmount?: string;
  /** Unix seconds. */
  validTo: number;
  /** bytes32 keccak hash of the full appData document. */
  appData: string;
  /** Full appData JSON document as a string, or null when the orderbook does not have it. */
  fullAppData: string | null;
  /** ISO-8601 timestamp. */
  creationDate: string;
}

/** Trade as returned by GET /trades. */
export interface CowTrade {
  orderUid: string;
  owner: string;
  txHash: string;
  blockNumber: number;
  sellAmount: string;
  buyAmount: string;
  sellToken: string;
  buyToken: string;
}

export interface SolverCompetitionSolution {
  solverAddress?: string;
  solver?: string;
  ranking?: number;
  score?: string;
  isWinner?: boolean;
  [key: string]: unknown;
}

/**
 * Solver competition data for a settlement. Typed loosely: the orderbook has
 * changed this payload across versions and we only ever read it opportunistically.
 */
export interface SolverCompetition {
  auctionId?: number;
  transactionHashes?: string[];
  solutions?: SolverCompetitionSolution[];
  [key: string]: unknown;
}

export const COW_BSC_API_BASE = 'https://api.cow.fi/bnb/api/v1';

export class CowApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message?: string) {
    super(message ?? `CoW orderbook API ${status} for ${url}`);
    this.name = 'CowApiError';
    this.status = status;
    this.url = url;
  }
}

export interface CowClientOptions {
  /** Defaults to the CoW-hosted BSC orderbook. */
  baseUrl?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface GetAccountOrdersOptions {
  /** 1 to 1000 per the orderbook API. */
  limit?: number;
  offset?: number;
}

export interface GetTradesQuery {
  owner?: Address;
  orderUid?: string;
}

export class CowOrderbookClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CowClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? COW_BSC_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async getRaw(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
    });
    return res;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.getRaw(path);
    if (!res.ok) throw new CowApiError(res.status, `${this.baseUrl}${path}`);
    return (await res.json()) as T;
  }

  async getAccountOrders(owner: Address, opts: GetAccountOrdersOptions = {}): Promise<CowOrder[]> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000) {
        throw new RangeError(`limit must be an integer in [1, 1000], got ${opts.limit}`);
      }
      params.set('limit', String(opts.limit));
    }
    if (opts.offset !== undefined) {
      if (!Number.isInteger(opts.offset) || opts.offset < 0) {
        throw new RangeError(`offset must be a non-negative integer, got ${opts.offset}`);
      }
      params.set('offset', String(opts.offset));
    }
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return this.get<CowOrder[]>(`/account/${owner}/orders${qs}`);
  }

  async getOrder(uid: string): Promise<CowOrder> {
    return this.get<CowOrder>(`/orders/${uid}`);
  }

  async getTrades(q: GetTradesQuery): Promise<CowTrade[]> {
    // The orderbook rejects requests carrying both filters, and an unfiltered
    // /trades is unbounded, so exactly one selector is required here.
    if ((q.owner === undefined) === (q.orderUid === undefined)) {
      throw new TypeError('getTrades requires exactly one of { owner, orderUid }');
    }
    const params = new URLSearchParams();
    if (q.owner !== undefined) params.set('owner', q.owner);
    if (q.orderUid !== undefined) params.set('orderUid', q.orderUid);
    return this.get<CowTrade[]>(`/trades?${params.toString()}`);
  }

  /** Returns null on 404: settlements older than the competition retention window have no record. */
  async getSolverCompetitionByTxHash(txHash: string): Promise<SolverCompetition | null> {
    const path = `/solver_competition/by_tx_hash/${txHash}`;
    const res = await this.getRaw(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new CowApiError(res.status, `${this.baseUrl}${path}`);
    return (await res.json()) as SolverCompetition;
  }
}

/**
 * True when the order's appData document declares appCode "ophis".
 *
 * Attribution MUST gate on appCode and never on the EIP-712 signing domain:
 * BSC is a CoW-hosted deployment, so the settlement domain is shared with
 * CoW Swap and every other integrator on the chain.
 */
export function isOphisOrder(order: Pick<CowOrder, 'appData' | 'fullAppData'>): boolean {
  if (!order.fullAppData || !/^0x[0-9a-fA-F]{64}$/.test(order.appData)) return false;
  try {
    if (keccak256(toBytes(order.fullAppData)).toLowerCase() !== order.appData.toLowerCase()) {
      return false;
    }
    const parsed: unknown = JSON.parse(order.fullAppData);
    if (!parsed || typeof parsed !== 'object') return false;
    return (parsed as { appCode?: unknown }).appCode === 'ophis';
  } catch {
    return false;
  }
}

const GPV2_ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
} as const;

/**
 * Recompute the canonical BSC CoW UID (order digest + owner + validTo). This
 * binds every order field used by receipts/leaderboards back to the UID the
 * caller requested, so an API response cannot silently splice fields from a
 * different order into a valid-looking Ophis document.
 */
export function isOrderUidValid(order: CowOrder): boolean {
  if (!/^0x[0-9a-fA-F]{112}$/.test(order.uid) || !isAddress(order.owner) || !isAddress(order.receiver)) {
    return false;
  }
  try {
    const digest = hashTypedData({
      domain: {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: 56,
        verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
      },
      types: GPV2_ORDER_TYPES,
      primaryType: 'Order',
      message: {
        sellToken: order.sellToken as Hex,
        buyToken: order.buyToken as Hex,
        receiver: order.receiver as Hex,
        sellAmount: BigInt(order.sellAmount),
        buyAmount: BigInt(order.buyAmount),
        validTo: order.validTo,
        appData: order.appData as Hex,
        feeAmount: BigInt(order.feeAmount),
        kind: order.kind,
        partiallyFillable: order.partiallyFillable,
        sellTokenBalance: order.sellTokenBalance,
        buyTokenBalance: order.buyTokenBalance,
      },
    });
    const expected = concatHex([
      digest,
      order.owner as Hex,
      numberToHex(order.validTo, { size: 4 }),
    ]);
    return expected.toLowerCase() === order.uid.toLowerCase();
  } catch {
    return false;
  }
}

export function isAuthenticOphisOrder(order: CowOrder): boolean {
  return isOphisOrder(order) && isOrderUidValid(order);
}
