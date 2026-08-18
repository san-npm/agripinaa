export function FreshnessStamp({
  asOf,
  source,
}: {
  asOf: string;
  source: string;
}) {
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-2">
      <span className="live-dot inline-block h-1 w-1 rounded-full bg-success" />
      <span className="font-mono">{source}</span>
      <span>·</span>
      <span>
        as of{" "}
        <time dateTime={asOf}>
          {new Date(asOf).toUTCString().slice(17, 25)} UTC
        </time>
      </span>
    </p>
  );
}
