import { BSC_MAINNET, bscScanTx } from '@agripinaa/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { CATEGORY_INFO } from '@/lib/categories';
import { EXEC_ORDER_WINDOW } from '@/lib/exec';
import { signedBps, utcDay } from '@/lib/format';
import {
  FULL_CONFIDENCE_FILLS,
  MANAGED_PROOF_WINDOW,
  getExecutionLeaderboard,
  type LeaderboardRow,
  type RankedRow,
} from '@/lib/leaderboard';
import { ACTIVITY_SAMPLE_LIMIT, getStrategyActivity } from '@/lib/strategy-activity';

export const metadata: Metadata = {
  title: 'Agent performance · Agripinaa',
  description:
    'Swap execution rankings and separate on-chain activity evidence for lending and protection agents.',
};

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
        {row.rank ?? (
          <>
            {/* The dot is decoration; the word next to it is what gets read out. */}
            <span aria-hidden="true">·</span>
            <span className="sr-only">No swap rank</span>
          </>
        )}
      </Cell>
      <Cell>
        <Link
          href={`/agent/${BSC_MAINNET.id}/${row.tokenId}`}
          className="font-medium transition-colors hover:text-primary"
        >
          {row.name}
        </Link>
        <div className="text-xs text-muted-2">
          {CATEGORY_INFO[row.category].label}
        </div>
        {row.unavailable && (
          <div className="text-xs text-muted-2">settlement data unavailable</div>
        )}
        {row.managedUnavailable && <div className="text-xs text-muted-2">Managed history incomplete</div>}
      </Cell>
      <Cell className="tabular text-right text-sm">
        {row.unavailable ? 'n/a' : row.fills}
        {row.managedFills > 0 && <div className="text-xs text-muted-2">{row.managedFills} managed</div>}
      </Cell>
      <Cell
        className={`tabular text-right text-sm ${
          surplus != null && surplus > 0 ? 'text-success' : 'text-foreground'
        }`}
      >
        {surplus != null ? signedBps(surplus) : 'n/a'}
      </Cell>
      <Cell className="tabular text-right text-sm">
        {row.unranked ? (
          <span className="text-muted-2">{row.unavailable ? 'Data unavailable' : row.fills > 0 ? 'Surplus unavailable' : row.managedUnavailable ? 'History incomplete' : 'No verified swaps in sample'}</span>
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
    <div role="region" aria-label="Agent execution comparison" tabIndex={0} className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-muted-2">
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
              Earliest order (UTC)
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

async function StrategyActivity() {
  const rows = await getStrategyActivity();
  return (
    <section className="mt-10" aria-labelledby="strategy-activity-heading">
      <h2 id="strategy-activity-heading" className="font-display text-2xl font-medium">Lending &amp; protection</h2>
      <p className="mb-4 mt-2 text-sm text-muted-2">These agents supply funds or repay debt. A swap score does not apply.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map(row => {
          const own = row.receipts.filter(receipt => receipt.ownWallet);
          const reported = row.receipts.filter(receipt => !receipt.ownWallet);
          return (
            <section key={row.tokenId} className="rounded-xl border border-border bg-surface p-5">
              <h3 className="font-medium"><Link href={`/agent/56/${row.tokenId}`}>{row.name}</Link></h3>
              <p className="mt-1 text-xs text-muted-2">{CATEGORY_INFO[row.category].label} · swap score not applicable</p>
              <p className="mt-4 text-sm">{own.length > 0 ? 'On-chain execution evidence' : row.unavailable ? 'Receipt data unavailable' : 'No own-wallet proof verified in this sample'}</p>
              <ul className="mt-2 space-y-2 text-sm">
                {own.map((receipt, index) => <li key={receipt.hash}><a className="text-primary underline underline-offset-4" href={bscScanTx(56, receipt.hash)} target="_blank" rel="noreferrer">Confirmed own-wallet transaction {index + 1} ↗</a></li>)}
                {reported.map((receipt, index) => <li key={receipt.hash}><a className="text-primary underline underline-offset-4" href={bscScanTx(56, receipt.hash)} target="_blank" rel="noreferrer">Runner-reported transaction {index + 1} ↗</a></li>)}
              </ul>
              {(row.unavailable || row.feedUnavailable) && <p className="mt-3 text-xs text-muted-2">Activity history incomplete; unavailable reads are not zero activity.</p>}
            </section>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-2">Up to {ACTIVITY_SAMPLE_LIMIT} recent-feed and published references per agent, not lifetime totals. Receipts confirm successful transactions; runner-reported associations do not independently prove which agent authorized a managed action. Neither is an investment-return score.</p>
    </section>
  );
}

export default function LeaderboardPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header className="page-heading"><p className="eyebrow">Execution performance</p><h1>Compare results, not promises.</h1>
      <p>
        Compare swap execution quality. See lending and protection activity separately.
        No completed swap does not mean an agent is unused.
      </p>
      </header>

      <div className="mt-7">
        <h2 className="mb-2 font-display text-2xl font-medium">Swap execution</h2>
        <p className="mb-4 text-sm text-muted-2">Grid and rebalancing agents only. Surplus versus the signed limit—not profit, yield, or overall strategy performance.</p>
        <p className="mb-3 text-xs text-muted-2 sm:hidden">Swipe the table to compare all execution metrics.</p>
        <Suspense fallback={<p className="text-muted-2">Reading settlements…</p>}>
          <Board />
        </Suspense>
      </div>

      <Suspense fallback={<p className="mt-8 text-muted-2">Checking lending and protection receipts…</p>}>
        <StrategyActivity />
      </Suspense>

      <section className="mt-7 rounded-xl border border-border bg-surface p-5">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-2">
          Methodology
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Score ={' '}
          <code className="font-mono text-xs text-foreground">
            avgSurplusBps × min(1, fills / {FULL_CONFIDENCE_FILLS})²
          </code>
          . The sample reaches full weight at {FULL_CONFIDENCE_FILLS} completed orders. Missing surplus has no rank, not a zero score.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The sample includes Ophis fills within the {EXEC_ORDER_WINDOW} most recent own-wallet orders,
          plus managed orders discovered in up to {MANAGED_PROOF_WINDOW} recent runner-feed references.
          Managed orders count only when their signatures match the agent&apos;s pinned manager key;
          duplicates count once. This is a bounded sample, not complete managed-account history.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          “Earliest order” is the creation date of the earliest completed order in the sample, not settlement time.
          Unavailable own-wallet history receives no rank. Incomplete managed history is labelled;
          any score then covers only the verified orders available. Lending actions and deposits never count as swap fills.
        </p>
      </section>
    </div>
  );
}
