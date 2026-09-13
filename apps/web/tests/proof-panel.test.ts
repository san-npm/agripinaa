import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('proof rows link each position through the manager that minted it and txs through the explorer', () => {
  // Rendered in a plain React process, like ui-security.test.ts, because this
  // suite runs under react-server conditions.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { bscScanNft, bscScanTx } from '@agripinaa/shared';
    import { ProofPanel } from './src/components/ProofPanel.tsx';
    import { VERIFIED_AGENTS } from './src/lib/verified.ts';
    globalThis.React = React;
    const UNISWAP_NPM = '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613';
    const PANCAKE_NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';
    const tx = '0x' + 'ab'.repeat(32);
    const ranger = VERIFIED_AGENTS['269706'];
    const html = renderToStaticMarkup(React.createElement(ProofPanel, { agent: {
      ...ranger,
      proofs: [...ranger.proofs, { label: 'Synthetic fill', ref: tx, kind: 'tx', note: 'tx rows are unchanged' }],
    } }));
    assert.ok(html.includes('href="' + bscScanNft(56, UNISWAP_NPM, '2745250') + '"'), 'the Uniswap row links the NFT instance under the Uniswap position manager');
    assert.ok(html.includes('href="https://bscscan.com/nft/' + UNISWAP_NPM + '/2745250"'), 'the NFT-instance route, not the contract address page');
    assert.ok(html.includes('position #2745250'));
    assert.ok(html.includes('href="' + bscScanNft(56, PANCAKE_NPM, '7173629') + '"'), 'rows without positionManager keep the PancakeSwap default');
    assert.ok(html.includes('href="' + bscScanTx(56, tx) + '"'), 'tx rows link the transaction');
    assert.ok(html.includes('execution tx'));
    assert.ok(!html.includes(PANCAKE_NPM + '/2745250') && !html.includes('?a='), 'the Uniswap position must not be looked up on PancakeSwap, and no row uses the address filter');
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
