import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('funding renders exact BTCB accounting and warns only for majority provisioning', () => {
  // The suite uses react-server for route tests. Render this client component
  // in a separate normal React process, without those server-only conditions.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { FundingDeposit } from './src/components/FundingDeposit.tsx';
    globalThis.React = React;
    const render = (gross, quote = true, preparationStatus, extra = {}) => renderToStaticMarkup(React.createElement(FundingDeposit, {
      address: '0x3cf79da486a3b286864f52139da73ff32ba7b972', asset: 'BTCB',
      balances: { BTCB: gross, BNB: 0n, USDT: 0n, USDC: 0n },
      gasQuote: quote ? { gasReserveInput: 17840405821843n,
        bootstrapFeeInput: 1931761574756n, registrationCount: 2 } : null,
      gasConversionRequired: true, quoteError: null, onAssetChange: () => {},
      preparationStatus,
      ...extra,
    }));
    const html = render(25976153706966n);
    for (const exact of ['0.000025976153706966', '0.000017840405821843',
      '0.000001931761574756', '0.000006203986310367']) assert.ok(html.includes(exact), exact);
    assert.match(html, /More than half/);
    assert.doesNotMatch(render(1000000000000000n), /More than half/);
    assert.doesNotMatch(render(0n), /More than half/);
    assert.doesNotMatch(render(25976153706966n, false), /More than half/);
    assert.match(html, /Copy address/);
    for (const status of ['submitted', 'confirmed']) {
      const saved = render(25976153706966n, true, status);
      assert.doesNotMatch(saved, /Copy address|Send BTCB once/);
      assert.match(saved, /Available to strategy/);
      const checkpoint = render(0n, true, status, {
        preparedPlan: { grossInput: 25976153706966n, gasReserveInput: 17840405821843n,
          bootstrapFeeInput: 1931761574756n, strategyInput: 6203986310367n },
        preparationTransactionHash: '0x' + 'ab'.repeat(32), locked: true,
      });
      assert.match(checkpoint, new RegExp(status === 'confirmed' ? 'Funding confirmed' : 'Funding submitted'));
      assert.ok(checkpoint.includes('0.000025976153706966'), 'saved gross survives a spent deposit balance');
      assert.ok(checkpoint.includes('0.000006203986310367'), 'saved strategy allocation is unchanged');
      assert.equal((checkpoint.match(/disabled=""/g) ?? []).length, 4, 'all asset selectors stay locked');
      assert.equal(checkpoint.includes('View confirmed transaction'), status === 'confirmed');
      assert.doesNotMatch(checkpoint, /Copy address|Send BTCB once/);
    }
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
