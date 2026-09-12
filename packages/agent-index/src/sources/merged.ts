import bscSnapshot from '../../data/agents-56.json';
import { parseSnapshot } from '../snapshot';
import type { AgentIndexSource } from '../source';
import type {
  AgentDetail,
  AgentSummary,
  Feedback,
  IndexStats,
  ListAgentsQuery,
  Page,
} from '../types';
import { readAgentFromRegistry } from './registry-viem';
import { Scan8004Source } from './scan8004';
import { TheGraphSource, isGraphCursor } from './thegraph';

/**
 * A continuation cursor belongs to the lane that issued it, and that lane
 * could not answer. There is no page to serve: another lane would read the
 * cursor as its own offset and silently end or skip the listing.
 */
export class IndexCursorLaneError extends Error {
  constructor(cursor: string) {
    super(`the index lane that issued cursor ${cursor} is unavailable; start again without a cursor`);
    this.name = 'IndexCursorLaneError';
  }
}

// Bundle the fallback: webpack turns import.meta.url into a build-machine path,
// which is not the path where Vercel runs the deployed function.
const BSC_SNAPSHOT = JSON.stringify(bscSnapshot);

interface CacheEntry<T> {
  value: T;
  at: number;
}

/** An indexer record that has the registration but not the agentURI
 * document yet: placeholder name and no classifiable category. */
function isMetadataPoor(agent: AgentDetail): boolean {
  return /^Agent #\d+$/.test(agent.name) || (!agent.description && agent.category == null);
}

/** A search result together with what produced it. */
export interface SearchOutcome {
  items: AgentSummary[];
  /**
   * `'index'` when the live index answered this search. `'fallback'` when it
   * did not: the items then come off the committed snapshot, a local sample
   * rather than the index, so an empty result is not evidence that nothing in
   * the registry matches.
   */
  source: 'index' | 'fallback';
}

/**
 * Priority: live lanes in order (The Graph when a gateway key is configured,
 * then 8004scan) → committed snapshot (lists) or direct registry read
 * (details) → last-known-good stale cache. Every response is labeled with its
 * source so the UI can show provenance instead of pretending.
 */
export class MergedSource implements AgentIndexSource {
  readonly name = 'merged';
  private readonly live: AgentIndexSource[] = [
    ...(TheGraphSource.configured() ? [new TheGraphSource()] : []),
    new Scan8004Source(),
  ];
  private readonly staleCache = new Map<string, CacheEntry<unknown>>();

  /** First live lane that answers; the last lane's error when none does. */
  private async firstLive<T>(read: (lane: AgentIndexSource) => Promise<T>): Promise<T> {
    let failure: unknown;
    for (const lane of this.live) {
      try {
        return await read(lane);
      } catch (err) {
        failure = err;
      }
    }
    throw failure;
  }

  private remember<T>(key: string, value: T): T {
    this.staleCache.set(key, { value, at: Date.now() });
    return value;
  }

  private stale<T>(key: string): T | null {
    const hit = this.staleCache.get(key);
    return hit ? (hit.value as T) : null;
  }

  private async loadSnapshot(chainId: number): Promise<AgentSummary[] | null> {
    if (chainId !== bscSnapshot.chainId) return null;
    return parseSnapshot(BSC_SNAPSHOT)?.items ?? null;
  }

  async listAgents(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    const key = `list:${q.chainId}:${q.category ?? 'all'}:${q.cursor ?? '1'}:${q.limit ?? 24}`;
    // A Graph cursor is an agentId, not an offset: only the lane that issued
    // it may continue it, and no snapshot page corresponds to it.
    if (q.cursor !== undefined && isGraphCursor(q.cursor)) {
      const graph = this.live.find((lane) => lane instanceof TheGraphSource);
      try {
        if (!graph) throw new IndexCursorLaneError(q.cursor);
        return this.remember(key, await graph.listAgents(q));
      } catch {
        const stale = this.stale<Page<AgentSummary>>(key);
        if (stale) return { ...stale, source: `${stale.source} (stale)` };
        throw new IndexCursorLaneError(q.cursor);
      }
    }
    try {
      return this.remember(key, await this.firstLive((lane) => lane.listAgents(q)));
    } catch {
      const snapshot = await this.loadSnapshot(q.chainId);
      if (snapshot) {
        const filtered = q.category
          ? snapshot.filter((a) => a.category === q.category)
          : snapshot;
        const limit = q.limit ?? 24;
        const page = q.cursor ? Number.parseInt(q.cursor, 10) : 1;
        const start = (page - 1) * limit;
        const items = filtered.slice(start, start + limit);
        return {
          items,
          nextCursor: start + limit < filtered.length ? String(page + 1) : null,
          total: filtered.length,
          asOf: new Date().toISOString(),
          source: 'snapshot',
        };
      }
      const stale = this.stale<Page<AgentSummary>>(key);
      if (stale) return { ...stale, source: `${stale.source} (stale)` };
      throw new Error(
        `agent-index: no live index answered and no snapshot for chain ${q.chainId}`,
      );
    }
  }

  async getAgent(chainId: number, tokenId: string): Promise<AgentDetail | null> {
    const key = `agent:${chainId}:${tokenId}`;
    try {
      const fromScan = await this.firstLive((lane) => lane.getAgent(chainId, tokenId));
      // A null from the indexer is not proof of nonexistence: fresh
      // registrations lag it (BSC lane is rpc_only). The registry is the
      // source of truth for existence; only a null THERE is final.
      if (fromScan && !isMetadataPoor(fromScan)) return this.remember(key, fromScan);
      // The indexer often lists a registration before it fetches the
      // agentURI document (name null, no category). Enrich identity fields
      // from the chain + manifest; keep the indexer's trust scores.
      const fromRegistry = await readAgentFromRegistry(chainId, tokenId);
      if (fromScan && fromRegistry) {
        return this.remember(key, {
          ...fromScan,
          name: fromRegistry.name,
          description: fromRegistry.description || fromScan.description,
          imageUrl: fromScan.imageUrl ?? fromRegistry.imageUrl,
          category: fromRegistry.category ?? fromScan.category,
          agentURI: fromRegistry.agentURI ?? fromScan.agentURI,
          agentWallet: fromScan.agentWallet ?? fromRegistry.agentWallet,
          metadata: fromRegistry.metadata ?? fromScan.metadata,
        });
      }
      return this.remember(key, fromScan ?? fromRegistry);
    } catch {
      const fromRegistry = await readAgentFromRegistry(chainId, tokenId);
      if (fromRegistry) return this.remember(key, fromRegistry);
      return this.stale<AgentDetail | null>(key);
    }
  }

  /**
   * Search, keeping what answered it.
   *
   * `searchAgents` flattens a live answer and a snapshot fallback into one
   * array, so a caller reading an empty one cannot tell "the index found
   * nothing" from "nothing searched the index". A directory that renders the
   * second as "no agents match" states something it never checked, so the two
   * are kept apart here and `searchAgents` stays the flat interface method.
   */
  async searchAgentsWithSource(
    chainId: number,
    query: string,
  ): Promise<SearchOutcome> {
    try {
      return {
        items: await this.firstLive((lane) => lane.searchAgents(chainId, query)),
        source: 'index',
      };
    } catch {
      const snapshot = await this.loadSnapshot(chainId);
      if (!snapshot) return { items: [], source: 'fallback' };
      const q = query.toLowerCase();
      return {
        items: snapshot.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        ),
        source: 'fallback',
      };
    }
  }

  async searchAgents(chainId: number, query: string): Promise<AgentSummary[]> {
    return (await this.searchAgentsWithSource(chainId, query)).items;
  }

  async getFeedback(chainId: number, tokenId: string): Promise<Feedback[]> {
    const key = `feedback:${chainId}:${tokenId}`;
    try {
      return this.remember(key, await this.firstLive((lane) => lane.getFeedback(chainId, tokenId)));
    } catch {
      return this.stale<Feedback[]>(key) ?? [];
    }
  }

  async stats(chainId: number): Promise<IndexStats> {
    const key = `stats:${chainId}`;
    try {
      return this.remember(key, await this.firstLive((lane) => lane.stats(chainId)));
    } catch {
      const stale = this.stale<IndexStats>(key);
      if (stale) return { ...stale, source: `${stale.source} (stale)` };
      const snapshot = await this.loadSnapshot(chainId);
      return {
        totalAgents: snapshot?.length ?? null,
        // The snapshot is seeded per chain, so its length is already scoped.
        chainScoped: snapshot != null,
        totalFeedbacks: null,
        asOf: new Date().toISOString(),
        source: 'snapshot',
      };
    }
  }
}
