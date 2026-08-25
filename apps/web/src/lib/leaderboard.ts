import 'server-only';

import { AGENT_LIST, type AgentCategory, type AgentRecord } from '@agripinaa/shared/agents';
import { cacheLife } from 'next/cache';

import { getTrackRecord } from './exec';

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

/** An execution row plus the marketplace category the table shows next to it. */
export interface LeaderboardRow extends ExecutionRow {
  category: AgentCategory;
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
 * A null average (fills whose surplus never computed) scores zero rather than
 * NaN, which would make the sort order depend on the input order.
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
    unranked: row.fills === 0,
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

/** A registry record that has been minted and funded, so it can have a record. */
type LiveAgent = AgentRecord & { tokenId: string; wallet: `0x${string}` };

function isLive(agent: AgentRecord): agent is LiveAgent {
  return agent.tokenId !== null && agent.wallet !== null;
}

/**
 * The leaderboard as rendered: every registered first-party agent, ranked on
 * its own settlement history.
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
  const firstParty = await Promise.all(
    AGENT_LIST.filter(isLive).map(async (agent): Promise<LeaderboardRow> => {
      const record = await getTrackRecord(agent.wallet);
      return {
        tokenId: agent.tokenId,
        name: agent.name,
        category: agent.category,
        fills: record.fills,
        avgSurplusBps: record.avgSurplusBps,
        firstSeen: record.firstSeen,
      };
    }),
  );
  return rankByExecution([...firstParty, ...extra]);
}
