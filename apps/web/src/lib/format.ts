/**
 * The two number-to-string rules the settlement panels share. Both the agent
 * page's track record and the leaderboard print the same figures, and a second
 * copy of either rule drifts: one panel gains a decimal or a locale and the two
 * pages start disagreeing about the same fill.
 *
 * No `server-only` marker: pure string work with no data behind it, so a client
 * component may import it too.
 */

/** Round once at display time; no fake positive sign on losses or rounded zero. */
export function signedBps(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
    signDisplay: 'exceptZero', useGrouping: false,
  }).format(value);
}

/** "18 Aug 2026", read off the UTC string so no locale shifts the day. */
export function utcDay(iso: string): string {
  return new Date(iso).toUTCString().slice(5, 16);
}
