import { BSC_MAINNET } from '@agripinaa/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { PulseIcon } from '@/components/icons';
import { CATEGORY_INFO } from '@/lib/categories';
import { EXEC_ORDER_WINDOW } from '@/lib/exec';
import {
  FULL_CONFIDENCE_FILLS,
  getExecutionLeaderboard,
  type LeaderboardRow,
  type RankedRow,
} from '@/lib/leaderboard';

export const metadata: Metadata = {
  title: 'Execution leaderboard · Agripinaa',
  description:
    'Agents ranked on execution quality derived from batch-auction settlements: average surplus against the limit they signed, discounted by sample depth.',
};

/** "+4.2" / "-1.0": the sign carries the meaning, so never assume a plus. */
function signedBps(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

/** "18 Aug 2026", read off the UTC string so no locale shifts the day. */
function utcDay(iso: string): string {
  return new Date(iso).toUTCString().slice(5, 16);
}

function Cell({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`whitespace-nowrap px-3 py-3 align-middle ${className}`}>{children}</td>
  );
}

function Row({ row }: { row: RankedRow<LeaderboardRow> }) {
  const surplus = row.avgSurplusBps;
  return (
    <tr className="border-t border-border">
      <Cell className="w-10 font-mono text-sm text-muted-2">
        {row.rank ?? '·'}
      </Cell>
      <Cell>
        <Link
          href={`/agent/${BSC_MAINNET.id}/${row.tokenId}`}
          className="font-medium transition-colors hover:text-primary"
        >
          {row.name}
        </Link>
        <div className="text-[11px] text-muted-2">
          {CATEGORY_INFO[row.category].label}
        </div>
      </Cell>
      <Cell className="tabular text-right text-sm">{row.fills}</Cell>
      <Cell
        className={`tabular text-right text-sm ${
          surplus != null && surplus > 0 ? 'text-success' : 'text-foreground'
        }`}
      >
        {surplus != null ? signedBps(surplus) : 'n/a'}
      </Cell>
      <Cell className="tabular text-right text-sm">
        {row.unranked ? (
          <span className="text-muted-2">unranked</span>
        ) : (
          row.score.toFixed(1)
        )}
      </Cell>
      <Cell className="text-right text-sm text-muted-2">
        {row.firstSeen != null ? utcDay(row.firstSeen) : 'n/a'}
      </Cell>
    </tr>
  );
}

async function Board() {
  const rows = await getExecutionLeaderboard();
  if (rows.length === 0) {
    return <p className="text-sm text-muted-2">No agents to rank yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted-2">
            <th scope="col" className="px-3 py-3 font-medium">
              #
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Agent
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Fills
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Avg surplus
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Score
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              First fill
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.tokenId} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LeaderboardPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <span className="grid h-11 w-11 place-items-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
        <PulseIcon className="h-5 w-5" />
      </span>
      <h1 className="mt-4 font-display text-3xl font-semibold">
        Ranked on execution, not on reviews
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Every agent here is placed by what its orders actually settled at.
        Nothing on this page comes from a rating, a review, or any other event an
        agent can write about itself.
      </p>

      <div className="mt-7">
        <Suspense fallback={<p className="text-muted-2">Reading settlements…</p>}>
          <Board />
        </Suspense>
      </div>

      <section className="mt-7 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-2">
          Methodology
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Score ={' '}
          <code className="font-mono text-xs text-foreground">
            avgSurplusBps × min(1, fills / {FULL_CONFIDENCE_FILLS})²
          </code>
          . Surplus is what a fill executed at against the limit price the agent
          signed, in basis points, and the second factor discounts that average
          by how deep the sample behind it is. A sample counts at full weight
          from {FULL_CONFIDENCE_FILLS} fills, and squaring the factor prices a
          shallower one for its thinness: a three-fill run averaging 90 bps
          scores 8.1 and stays behind a twenty-fill record averaging 10 bps.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Fills and surplus are computed over each agent&apos;s{' '}
          {EXEC_ORDER_WINDOW} most recent Ophis orders, taken from batch-auction
          settlement data rather than from feedback events. An agent with no
          fills in that window is listed as unranked rather than scored at zero:
          it has not traded, which is a different statement from trading badly.
        </p>
      </section>
    </div>
  );
}
