/**
 * How far a two-asset inventory sits from a target split BY VALUE, and how much
 * has to change hands to put it back.
 *
 * This is the arithmetic the LP agent has used since it shipped, to trade its
 * wallet back to 50/50 before re-minting a range. `weight-rebalancer` is that
 * same idea standing on its own, ticking on drift instead of on a position
 * leaving its range, so both read the gap from here rather than each carrying
 * its own version of it. Value in, value out: no token amounts, no decimals, no
 * chain access, which is what makes it the same function for an LP re-mint and
 * for a portfolio weight.
 */

/**
 * Signed USD distance from the target weight, measured on the base side.
 * Positive means base is overweight and must be sold; negative means base is
 * underweight and must be bought. The magnitude is exactly the trade that
 * lands on target, because moving X dollars from one side to the other closes a
 * gap of X.
 *
 * Written as `base * (1 - w) - quote * w` rather than `(base - quote) / 2` so it
 * generalises past 50/50. At w = 0.5 the two are bit-identical: 0.5 is a power
 * of two, so halving each side is exact and the rounded difference is the same
 * number either way. That matters because the LP agent's live swap sizing goes
 * through here.
 */
export function valueGapUsd(baseUsd: number, quoteUsd: number, targetWeight: number): number {
  return baseUsd * (1 - targetWeight) - quoteUsd * targetWeight;
}

/**
 * The base side's share of total value, or null when there is nothing to weigh.
 * A zero or negative total is not a 0 percent weight, it is an absent one, and
 * returning 0 would read as "maximally underweight" and invite a trade with no
 * capital behind it.
 */
export function weightOfBase(baseUsd: number, quoteUsd: number): number | null {
  const total = baseUsd + quoteUsd;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(baseUsd) || baseUsd < 0 || !Number.isFinite(quoteUsd) || quoteUsd < 0) {
    return null;
  }
  return baseUsd / total;
}

/** Drift from target in percentage POINTS of weight: a 50/50 book at 55/45 has
 * drifted 5, which is what a "5 percent band" means here. */
export function driftPoints(weight: number, targetWeight: number): number {
  return Math.abs(weight - targetWeight) * 100;
}
