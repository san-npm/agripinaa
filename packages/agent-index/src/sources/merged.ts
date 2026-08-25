import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SNAPSHOT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
);

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
 * Priority: live 8004scan → committed snapshot (lists) or direct registry
 * read (details) → last-known-good stale cache. Every response is labeled
 * with its source so the UI can show provenance instead of pretending.
 */
export class MergedSource implements AgentIndexSource {
  readonly name = 'merged';
  private readonly scan = new Scan8004Source();
  private readonly staleCache = new Map<string, CacheEntry<unknown>>();

  private remember<T>(key: string, value: T): T {
    this.staleCache.set(key, { value, at: Date.now() });
    return value;
  }

  private stale<T>(key: string): T | null {
    const hit = this.staleCache.get(key);
    return hit ? (hit.value as T) : null;
  }

  private async loadSnapshot(chainId: number): Promise<AgentSummary[] | null> {
    try {
      const raw = await readFile(
        join(SNAPSHOT_DIR, `agents-${chainId}.json`),
        'utf8',
      );
      const parsed = JSON.parse(raw) as { items: AgentSummary[] };
      return parsed.items;
    } catch {
      return null;
    }
  }

  async listAgents(q: ListAgentsQuery): Promise<Page<AgentSummary>> {
    const key = `list:${q.chainId}:${q.category ?? 'all'}:${q.cursor ?? '1'}:${q.limit ?? 24}`;
    try {
      return this.remember(key, await this.scan.listAgents(q));
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
        `agent-index: 8004scan unavailable and no snapshot for chain ${q.chainId}`,
      );
    }
  }

  async getAgent(chainId: number, tokenId: string): Promise<AgentDetail | null> {
    const key = `agent:${chainId}:${tokenId}`;
    try {
      const fromScan = await this.scan.getAgent(chainId, tokenId);
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
      return { items: await this.scan.searchAgents(chainId, query), source: 'index' };
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
      return this.remember(key, await this.scan.getFeedback(chainId, tokenId));
    } catch {
      return this.stale<Feedback[]>(key) ?? [];
    }
  }

  async stats(chainId: number): Promise<IndexStats> {
    const key = `stats:${chainId}`;
    try {
      return this.remember(key, await this.scan.stats(chainId));
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
