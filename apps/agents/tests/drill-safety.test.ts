import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectedHealthFactor } from '../src/drill-safety';

test('projectedHealthFactor includes the proposed debt before submission', () => {
  assert.equal(
    projectedHealthFactor({
      totalCollateralBase: 200_00000000n,
      totalDebtBase: 100_00000000n,
      liquidationThresholdBps: 8_000n,
      addedDebtBase: 20_00000000n,
    }),
    4 / 3,
  );
});
