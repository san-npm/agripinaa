/**
 * Independent floor for an Ophis quote. Prices arrive from a factory-verified
 * Pancake pool; this converts that separate reference into buy-token base units
 * before the orderbook is allowed to influence anything the wallet signs.
 */

export const REFERENCE_QUOTE_MAX_DEVIATION_BPS = 300;

export function independentMinimumBuyAmount(input: {
  sellAmount: string;
  buyUnitsPerSellUnit: number;
  buyDecimals: number;
  maxDeviationBps?: number;
}): string {
  const sellUnits = Number(input.sellAmount);
  const maxDeviationBps = input.maxDeviationBps ?? REFERENCE_QUOTE_MAX_DEVIATION_BPS;
  if (!Number.isFinite(sellUnits) || sellUnits <= 0) throw new RangeError('sellAmount must be positive');
  if (!Number.isFinite(input.buyUnitsPerSellUnit) || input.buyUnitsPerSellUnit <= 0) {
    throw new RangeError('reference price must be positive');
  }
  if (!Number.isInteger(input.buyDecimals) || input.buyDecimals < 0 || input.buyDecimals > 36) {
    throw new RangeError('buyDecimals out of range');
  }
  if (!Number.isInteger(maxDeviationBps) || maxDeviationBps < 0 || maxDeviationBps >= 10_000) {
    throw new RangeError('maxDeviationBps out of range');
  }

  const guardedWhole =
    sellUnits * input.buyUnitsPerSellUnit * ((10_000 - maxDeviationBps) / 10_000);
  // Eight decimal places are enough for these $1-$10 strategies and keep the
  // Number-to-integer step below MAX_SAFE_INTEGER. Flooring is deliberately
  // conservative: the guard can reject a bad quote but can never demand more
  // than the independent reference intended because of decimal rounding.
  const precision = Math.min(input.buyDecimals, 8);
  const scale = 10 ** precision;
  const scaled = Math.floor(guardedWhole * scale);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new RangeError('independent minimum is unsafe or rounds to zero');
  }
  return (BigInt(scaled) * 10n ** BigInt(input.buyDecimals - precision)).toString();
}
