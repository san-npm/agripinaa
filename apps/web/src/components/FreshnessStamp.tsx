export function FreshnessStamp({
  asOf,
  source,
}: {
  asOf: string;
  source: string;
}) {
  return (
    <p className="mt-2 text-[10px] text-zinc-600">
      {source} · as of{" "}
      <time dateTime={asOf}>{new Date(asOf).toUTCString().slice(17, 25)} UTC</time>
    </p>
  );
}
