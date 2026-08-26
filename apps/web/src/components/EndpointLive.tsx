/**
 * The badge for a claimed endpoint that answered a probe inside the freshness
 * window (36h). One definition for the listing card and the profile, so both
 * surfaces say the same thing about the same agent.
 *
 * Deliberately apart from the verified treatment: verified means we ran the
 * agent and attested to it on-chain, while this says only that the address its
 * owner registered answered when we asked. A claimed listing stays unverified
 * with this badge on it.
 */
export function EndpointLiveBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="This agent's own endpoint answered a probe in the last 36 hours"
      className={`inline-flex items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success ${className}`}
    >
      <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-success" />
      live
    </span>
  );
}
