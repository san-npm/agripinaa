import 'server-only';

import { AGENT_LIST, type AgentCategory, type AgentRecord } from '@agripinaa/shared/agents';
import { cacheLife } from 'next/cache';
import { CowOrderbookClient, isManagerSignedOrder, summarizeSurplus, surplusBps, type CowOrder } from '@agripinaa/exec-metrics';
import type { ProofEvent } from '@agripinaa/shared';

import { bestAndFirstFill, getWalletOphisOrders, type TrackRecord } from './exec';
import { getRunnerEvidence } from './proof';

const cow = new CowOrderbookClient({ fetch: (input, init) => fetch(input, {
  ...init, signal: AbortSignal.timeout(3_000),
}) });
// ponytail: recent feed only; a durable signed-execution index is needed for lifetime history.
export const MANAGED_PROOF_WINDOW = 40;
type LeaderboardRecord = TrackRecord & { managedFills?: number; managedUnavailable?: boolean };

/**
 * How many fills an agent needs before its average surplus is taken at face
 * value. Below this the average is discounted (see `executionScore`), and the
 * page prints the number rather than restating it in prose.
 */
export const FULL_CONFIDENCE_FILLS = 10;

/**
 * One agent's settlement record, reduced to what the ranking reads. Kept to
 * the four comparable numbers so anything with a wallet and an order history
 * can be ranked: first-party agents today, claimed agents once the claim flow
 * lands.
 *
 * `avgSurplusBps` and `firstSeen` are nullable because `getTrackRecord` is:
 * an agent with no fills has no average and no start date, which is not the
 * same statement as zero.
 */
export interface ExecutionRow {
  tokenId: string;
  name: string;
  fills: number;
  avgSurplusBps: number | null;
  firstSeen: string | null;
}

/**
 * An execution row plus the marketplace category the table shows next to it.
 *
 * `unavailable` marks a row whose settlement history could not be read at all.
 * Its four numbers are then absences rather than measurements, so the table
 * says so instead of printing a zero the agent did not earn.
 */
export interface LeaderboardRow extends ExecutionRow {
  category: AgentCategory;
  unavailable: boolean;
  managedFills: number;
  managedUnavailable: boolean;
}

/**
 * A row with its place in the table. `rank` is null exactly when `unranked` is
 * true, so a zero-fill agent is listed without being given a position it did
 * not earn.
 */
export type RankedRow<T extends ExecutionRow = ExecutionRow> = T & {
  rank: number | null;
  score: number;
  unranked: boolean;
};

/**
 * Average surplus discounted by how much of the sample the agent actually has.
 *
 * The discount is the confidence SQUARED rather than the confidence itself,
 * because a single factor of `fills / 10` is too weak to do the job this
 * leaderboard exists for: at 3 fills it still leaves 30% of the average, so an
 * agent that filled three orders at 90 bps would score 27 and leapfrog an agent
 * that filled twenty at 10 bps. Squaring leaves 9% instead, which prices the
 * thin sample for its thinness: 8.1 against 10, deep record first.
 *
 * A missing average gets a finite sorting placeholder, but no public score or rank.
 */
function executionScore(row: ExecutionRow): number {
  const confidence = Math.min(1, Math.max(0, row.fills / FULL_CONFIDENCE_FILLS));
  const avg = row.avgSurplusBps;
  if (avg == null || !Number.isFinite(avg)) return 0;
  return avg * confidence ** 2;
}

/**
 * Rank agents on settlement-derived execution quality: highest score first,
 * agents with no fills at all last and labelled `unranked` rather than being
 * scored against agents that have traded.
 *
 * Pure and total: every comparison falls through to the token id, so two runs
 * over the same rows produce the same table (an unstable tail would make the
 * leaderboard shuffle between page loads for no reason a reader can see).
 * Generic in the row so callers can carry extra display fields (category, and
 * later a claim's provenance) through the ranking untouched.
 */
export function rankByExecution<T extends ExecutionRow>(rows: readonly T[]): RankedRow<T>[] {
  const scored = rows.map((row) => ({
    ...row,
    score: executionScore(row),
    unranked: row.fills === 0 || row.avgSurplusBps === null || !Number.isFinite(row.avgSurplusBps),
  }));

  scored.sort((a, b) => {
    // An agent with nothing settled is not last on score, it is out of the
    // running: a negative-surplus record still beats no record at all.
    if (a.unranked !== b.unranked) return a.unranked ? 1 : -1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.fills !== b.fills) return b.fills - a.fills;
    return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0;
  });

  let position = 0;
  return scored.map((row) => ({
    ...row,
    rank: row.unranked ? null : ++position,
  }));
}

/** What the leaderboard needs off a registry record, and nothing else. */
type RankableAgent = Pick<AgentRecord, 'tokenId' | 'name' | 'category' | 'wallet'>;

/** A registry record that has been minted and funded, so it can have a record. */
type LiveAgent = RankableAgent & { tokenId: string; wallet: `0x${string}` };

function isLive(agent: RankableAgent): agent is LiveAgent {
  return agent.tokenId !== null && agent.wallet !== null;
}

/**
 * One row per agent that has an identity and a wallet, read through
 * `readRecord`.
 *
 * The reads are settled, not awaited together. Each one is a call to a public
 * orderbook that can fail on its own, and `/leaderboard` is prerendered: with
 * `Promise.all` a single upstream 502 rejects the whole page, which blanks the
 * table at runtime and fails the build outright. A row whose read failed is
 * carried as `unavailable`, which leaves it in the table and out of the
 * ranking (no fills, so `rankByExecution` puts it below every agent that has
 * traded and gives it no position).
 *
 * The reader is a parameter so the gathering can be tested against a failing
 * fetch without an orderbook, the same seam `bestAndFirstFill` uses in
 * `lib/exec.ts`.
 */
export async function gatherExecutionRows(
  agents: readonly RankableAgent[],
  readRecord: (wallet: string) => Promise<LeaderboardRecord>,
): Promise<LeaderboardRow[]> {
  const live = agents.filter(isLive);
  const settled = await Promise.allSettled(live.map((agent) => readRecord(agent.wallet)));
  return live.map((agent, index) => {
    const result = settled[index];
    const record = result?.status === 'fulfilled' ? result.value : null;
    return {
      tokenId: agent.tokenId,
      name: agent.name,
      category: agent.category,
      fills: record?.fills ?? 0,
      avgSurplusBps: record?.avgSurplusBps ?? null,
      firstSeen: record?.firstSeen ?? null,
      unavailable: record === null,
      managedFills: record?.managedFills ?? 0,
      managedUnavailable: record?.managedUnavailable ?? false,
    };
  });
}

/**
 * Swap-capable first-party agents, ranked on own-wallet history plus
 * signature-attributed managed orders. Lending/protection use activity evidence.
 *
 * Registry records with a null token id or a null wallet are skipped. Those
 * agents are configured but not yet minted or funded, so they have no identity
 * to link to and no wallet whose orders could be read: listing them would add
 * rows that are empty by construction.
 *
 * `extra` is the extension point for claimed agents. Once the claim flow can
 * bind a third-party agent to a wallet with Ophis receipts, its rows come in
 * here and rank alongside the first-party ones with no change to the ranking
 * or the page. Nothing passes it today.
 */
export async function getExecutionLeaderboard(
  extra: readonly LeaderboardRow[] = [],
): Promise<RankedRow<LeaderboardRow>[]> {
  'use cache';
  cacheLife('minutes');
  const feed = await getRunnerEvidence().catch(() => ({ events: [], available: false }));
  const reads = new Map<string, Promise<CowOrder>>();
  const readOrder = (uid: string) => {
    if (!reads.has(uid)) reads.set(uid, cow.getOrder(uid));
    return reads.get(uid)!;
  };
  const agents = AGENT_LIST.filter(agent => agent.category === 'grid' || agent.category === 'rebalancing');
  const firstParty = await gatherExecutionRows(agents, async wallet => {
    const agent = agents.find(agent => agent.wallet === wallet)!;
    const record = await readLeaderboardRecord(agent, feed.events, getWalletOphisOrders, readOrder);
    return { ...record, managedUnavailable: !feed.available || record.managedUnavailable };
  });
  return rankByExecution([...firstParty, ...extra]);
}

/** Feed references only discover orders. The order signature determines attribution. */
export async function readLeaderboardRecord(
  agent: Pick<AgentRecord, 'wallet' | 'managerKeys'>,
  events: readonly ProofEvent[],
  readOwn: (wallet: string) => Promise<CowOrder[]>,
  readOrder: (uid: string) => Promise<CowOrder>,
): Promise<LeaderboardRecord> {
  const own = await readOwn(agent.wallet!);
  const orders = new Map(own.map(order => [order.uid.toLowerCase(), order]));
  const candidates = [...new Set(events.slice(0, MANAGED_PROOF_WINDOW)
    .map(event => event.orderUid?.toLowerCase())
    .filter((uid): uid is string => !!uid && /^0x[0-9a-f]{112}$/.test(uid) && !orders.has(uid)))];
  const managers = Object.values(agent.managerKeys ?? {});
  let managedUnavailable = false;
  let managedFills = 0;
  // Each agent sees the same bounded candidate set: an untrusted agent label
  // cannot reassign a signed order or credit it to a different strategy.
  const settled = await Promise.all(candidates.map(async uid => {
    const order = await readOrder(uid);
    if (order.uid.toLowerCase() !== uid || order.owner.toLowerCase() === agent.wallet!.toLowerCase()
      || !await isManagerSignedOrder(order, managers)) return null;
    return order;
  }).map(promise => promise.catch(() => { managedUnavailable = true; return null; })));
  for (const order of settled) {
    if (!order) continue;
    orders.set(order.uid.toLowerCase(), order);
    if (order.status === 'fulfilled') managedFills++;
  }
  const all = [...orders.values()];
  const summary = summarizeSurplus(all);
  return {
    fills: summary.filledOrders,
    avgSurplusBps: summary.avgSurplusBps,
    ...bestAndFirstFill(all.map(order => ({ ...order, surplusBps: surplusBps(order) }))),
    managedFills,
    managedUnavailable,
  };
}
