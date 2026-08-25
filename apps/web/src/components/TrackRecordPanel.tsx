import { getTrackRecord } from "@/lib/exec";

/** "+4.2" / "-1.0": the sign carries the meaning, so never assume a plus. */
function signedBps(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

/** "18 Aug 2026", read off the UTC string so no locale shifts the day. */
function utcDay(iso: string): string {
  return new Date(iso).toUTCString().slice(5, 16);
}

/**
 * What an agent has actually done, cumulatively, from settlement data: how
 * many orders it has filled, how those fills priced against the limit it
 * signed, its single best fill, and how far back the record goes.
 *
 * The per-order list next to this answers "what did it just do"; this answers
 * "has it been working", which is the question a reader arriving cold has.
 * Server component, one cached fetch shared with the execution panel.
 */
export async function TrackRecordPanel({ wallet }: { wallet: string }) {
  const record = await getTrackRecord(wallet);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-2">
        Track record
      </h2>
      {record.fills === 0 ? (
        <p className="text-sm text-muted-2">No fills yet.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Fills" value={String(record.fills)} hint="settled orders" />
            <Stat
              label="Avg surplus"
              value={
                record.avgSurplusBps != null ? signedBps(record.avgSurplusBps) : "n/a"
              }
              hint="bps vs limit"
              positive={record.avgSurplusBps != null && record.avgSurplusBps > 0}
            />
            <Stat
              label="Best fill"
              value={record.bestFillBps != null ? signedBps(record.bestFillBps) : "n/a"}
              hint="bps"
              positive={record.bestFillBps != null && record.bestFillBps > 0}
            />
            <Stat
              label="First fill"
              value={record.firstSeen != null ? utcDay(record.firstSeen) : "n/a"}
              hint="UTC"
            />
          </dl>
          <p className="mt-3 text-[10px] leading-relaxed text-muted-2">
            Every filled Ophis order from this agent&apos;s wallet, not a sampled
            window. Surplus is executed against signed amounts.
          </p>
        </>
      )}
    </section>
  );
}

function Stat({
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
