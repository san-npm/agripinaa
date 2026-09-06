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
    const render = (gross, quote = true) => renderToStaticMarkup(React.createElement(FundingDeposit, {
      address: '0x3cf79da486a3b286864f52139da73ff32ba7b972', asset: 'BTCB',
      balances: { BTCB: gross, BNB: 0n, USDT: 0n, USDC: 0n },
      gasQuote: quote ? { gasReserveInput: 17840405821843n,
        bootstrapFeeInput: 1931761574756n, registrationCount: 2 } : null,
      gasConversionRequired: true, quoteError: null, onAssetChange: () => {},
    }));
    const html = render(25976153706966n);
    for (const exact of ['0.000025976153706966', '0.000017840405821843',
      '0.000001931761574756', '0.000006203986310367']) assert.ok(html.includes(exact), exact);
    assert.match(html, /More than half/);
    assert.doesNotMatch(render(1000000000000000n), /More than half/);
    assert.doesNotMatch(render(0n), /More than half/);
    assert.doesNotMatch(render(25976153706966n, false), /More than half/);
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
