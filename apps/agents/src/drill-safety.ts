export function projectedHealthFactor(input: {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint;
  addedDebtBase: bigint;
}): number {
  const debtAfter = input.totalDebtBase + input.addedDebtBase;
  if (debtAfter <= 0n) return Number.POSITIVE_INFINITY;
  const adjustedCollateral =
    (input.totalCollateralBase * input.liquidationThresholdBps) / 10_000n;
  return Number(adjustedCollateral) / Number(debtAfter);
}
