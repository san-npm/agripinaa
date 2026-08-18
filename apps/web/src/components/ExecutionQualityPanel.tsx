import { TOKENS_BSC } from '@agripinaa/shared';

import { getExecutionSummary } from '@/lib/exec';
import { FreshnessStamp } from './FreshnessStamp';
import { MevReceiptButton } from './MevReceiptButton';

const SYMBOL_BY_ADDRESS = new Map(
  Object.values(TOKENS_BSC).map((t) => [t.address.toLowerCase(), t.symbol]),
);

function tokenLabel(address: string): string {
  return SYMBOL_BY_ADDRESS.get(address.toLowerCase()) ?? `${address.slice(0, 6)}…`;
}

function formatAmount(raw: string, address: string): string {
  const decimals = 18; // every token in TOKENS_BSC is 18 on BNB Chain
  const value = Number(BigInt(raw)) / 10 ** decimals;
  void address;
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * Ophis-attributed execution history for an agent wallet. Server component:
 * data comes from the CoW BSC orderbook, surplus computed executed-vs-signed.
 */
export async function ExecutionQualityPanel({ wallet }: { wallet: string }) {
  const exec = await getExecutionSummary(wallet);

  if (exec.rows.length === 0) {
    return (
      <section className="rounded-lg border border-zinc-800 p-4">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Execution quality
        </h2>
        <p className="text-sm text-zinc-500">
          No Ophis-routed trades from this agent&apos;s wallet yet. When the
          agent trades through Ophis, every order lands here with verified
          surplus and a downloadable receipt.
        </p>
      </section>
    );
  }

  const { summary } = exec;
  return (
    <section className="rounded-lg border border-zinc-800 p-4">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Execution quality
      </h2>
      <dl className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-zinc-500">Ophis orders: </dt>
          <dd className="inline text-zinc-200">
            {summary.filledOrders}/{summary.totalOrders} filled
          </dd>
        </div>
        {summary.avgSurplusBps != null && (
          <div>
            <dt className="inline text-zinc-500">Avg surplus: </dt>
            <dd className="inline text-emerald-300">
              +{summary.avgSurplusBps.toFixed(1)} bps vs signed limit
            </dd>
          </div>
        )}
        {Object.entries(summary.totalSurplusRaw).map(([token, raw]) => (
          <div key={token}>
            <dt className="inline text-zinc-500">Surplus ({tokenLabel(token)}): </dt>
            <dd className="inline text-emerald-300">+{formatAmount(raw, token)}</dd>
          </div>
        ))}
      </dl>
      <ul className="space-y-2">
        {exec.rows.slice(0, 8).map((row) => (
          <li
            key={row.uid}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 p-2 text-xs"
          >
            <span className="text-zinc-300">
              {row.kind} {tokenLabel(row.sellToken)} → {tokenLabel(row.buyToken)}
            </span>
            <span className="text-zinc-500">{row.status}</span>
            {row.surplusBps != null && (
              <span className="text-emerald-300">+{row.surplusBps.toFixed(1)} bps</span>
            )}
            <MevReceiptButton uid={row.uid} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] text-zinc-600">
        Source: CoW orderbook (BSC), Ophis-attributed via appData appCode.
        Surplus = executed vs signed amounts.
      </p>
      <FreshnessStamp asOf={exec.asOf} source="api.cow.fi/bnb" />
    </section>
  );
}
