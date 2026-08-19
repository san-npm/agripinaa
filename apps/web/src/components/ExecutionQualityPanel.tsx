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
 * data comes from the Ophis settlement layer on BSC, surplus computed
 * executed-vs-signed.
 */
export async function ExecutionQualityPanel({ wallet }: { wallet: string }) {
  const exec = await getExecutionSummary(wallet);

  if (exec.rows.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-2">
          Execution quality
        </h2>
        <p className="text-sm text-muted-2">
          No Ophis-routed trades from this agent&apos;s wallet yet. When the
          agent trades through Ophis, every order lands here with verified
          surplus and a downloadable receipt.
        </p>
      </section>
    );
  }

  const { summary } = exec;
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-2">
        Execution quality
      </h2>
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Ophis orders"
          value={`${summary.filledOrders}/${summary.totalOrders}`}
          hint="filled"
        />
        {summary.avgSurplusBps != null && (
          <Metric
            label="Avg surplus"
            value={`+${summary.avgSurplusBps.toFixed(1)}`}
            hint="bps vs limit"
            positive
          />
        )}
        {Object.entries(summary.totalSurplusRaw)
          .slice(0, 2)
          .map(([token, raw]) => (
            <Metric
              key={token}
              label={`Surplus ${tokenLabel(token)}`}
              value={`+${formatAmount(raw, token)}`}
              positive
            />
          ))}
      </dl>
      <ul className="space-y-2">
        {exec.rows.slice(0, 8).map((row) => (
          <li
            key={row.uid}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 p-2.5 text-xs"
          >
            <span className="font-mono text-muted">
              {row.kind} {tokenLabel(row.sellToken)} → {tokenLabel(row.buyToken)}
            </span>
            <span className="text-muted-2">{row.status}</span>
            {row.surplusBps != null && (
              <span className="tabular font-mono text-success">
                +{row.surplusBps.toFixed(1)} bps
              </span>
            )}
            <MevReceiptButton uid={row.uid} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] leading-relaxed text-muted-2">
        Ophis settlement on BSC, attributed via appData appCode. Surplus =
        executed vs signed amounts.
      </p>
      <FreshnessStamp asOf={exec.asOf} source="ophis · BSC" />
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  positive,
}: {
  label: string;
  value: string;
  hint?: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-2">{label}</div>
      <div
        className={`tabular mt-1 font-mono text-lg font-medium ${positive ? "text-success" : "text-foreground"}`}
      >
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-2">{hint}</div>}
    </div>
  );
}
