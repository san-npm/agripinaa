/**
 * Client for the Ophis rebate-indexer public endpoints (rebates.ophis.fi).
 * Response shapes mirror the indexer's API (tier/xp/rank/leaderboard/stats).
 *
 * The service has been observed returning HTTP 530 (origin down), so every
 * method resolves to a discriminated ReputationResult instead of throwing:
 * callers are forced to branch on `ok` before touching data.
 */

export const REBATES_API_BASE = 'https://rebates.ophis.fi';

export type ReputationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status?: number; readonly error: string };

export interface TierInfo {
  name: string;
  min_usd: number;
  rebate_pct: number;
}

/** GET /tier/:wallet (JSON path; the same route serves HTML for browsers). */
export interface TierStatus {
  wallet: string;
  volume_30d_usd: number;
  trade_count_30d: number;
  tier: TierInfo;
  next_tier: TierInfo | null;
  usd_to_next_tier: number | null;
}

/** GET /xp/:wallet, 1 XP per USD of lifetime fee-bearing volume. */
export interface WalletXp {
  wallet: string;
  xp: number;
  lifetimeVolumeUsd: number;
  generatedAt: string;
}

/** GET /rank/:wallet; next* fields are null at the top tier, position null without indexed volume. */
export interface RankStatus {
  wallet: string;
  tier: string;
  volume30dUsd: number;
  rebatePct: number;
  nextTier: string | null;
  nextThresholdUsd: number | null;
  toNextUsd: number | null;
  position: number | null;
}

/** One row of GET /leaderboard. `wallet` is the truncated display address, not the full one. */
export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  tier: string;
  volume30dUsd: number;
  volumeTotalUsd: number;
  affiliateCount: number;
  referredVolumeUsd: number;
}

export interface LeaderboardResponse {
  updatedAt: string;
  total: number;
  entries: LeaderboardEntry[];
}

/** GET /stats: lifetime cumulative figures only, never current-cycle data. */
export interface PublicStats {
  totalVolumeUsd: number;
  totalTrades: number;
  distinctTraders: number;
  chainsActive: number;
  byChain: { chainId: number; volumeUsd: number; trades: number }[];
  avgTradeUsd: number | null;
  generatedAt: string;
  [key: string]: unknown;
}

export interface ReputationClientOptions {
  baseUrl?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export class ReputationClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ReputationClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? REBATES_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async get<T>(path: string): Promise<ReputationResult<T>> {
    const url = `${this.baseUrl}${path}`;
    try {
      // Accept: application/json is load-bearing: /tier and /stats
      // content-negotiate and serve an HTML page to browser Accept headers.
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        return { ok: false, status: res.status, error: `reputation API ${res.status} for ${url}` };
      }
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * GET /tier/:wallet. Named for its side effect: the indexer treats this
   * lookup as opt-in and ENROLLS the wallet for indexing. Do not call it for
   * wallets that have not consented to being indexed.
   */
  async enrollAndGetTier(wallet: string): Promise<ReputationResult<TierStatus>> {
    return this.get<TierStatus>(`/tier/${encodeURIComponent(wallet.toLowerCase())}`);
  }

  async getXp(wallet: string): Promise<ReputationResult<WalletXp>> {
    return this.get<WalletXp>(`/xp/${encodeURIComponent(wallet.toLowerCase())}`);
  }

  async getRank(wallet: string): Promise<ReputationResult<RankStatus>> {
    return this.get<RankStatus>(`/rank/${encodeURIComponent(wallet.toLowerCase())}`);
  }

  async getLeaderboard(limit = 100): Promise<ReputationResult<LeaderboardResponse>> {
    return this.get<LeaderboardResponse>(`/leaderboard?limit=${encodeURIComponent(String(limit))}`);
  }

  async getStats(): Promise<ReputationResult<PublicStats>> {
    return this.get<PublicStats>('/stats');
  }
}
