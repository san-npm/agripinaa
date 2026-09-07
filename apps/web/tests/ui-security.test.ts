import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('Proof token logos keep accessible tickers, unknown symbols and escaped prose', () => {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ProofSummary } from './src/components/ProofSummary.tsx';
    globalThis.React = React;
    const html = renderToStaticMarkup(React.createElement(ProofSummary, { text: 'Filled BTCB → USDT / WBNB / USDC; UNKNOWN <script>x</script>' }));
    for (const symbol of ['BTCB', 'USDT', 'WBNB', 'USDC']) assert.ok(html.includes('aria-label="' + symbol + '"'));
    assert.equal((html.match(/role="img"/g) || []).length, 4);
    assert.match(html, /UNKNOWN/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});

test('registry cards escape owner text and do not grant first-party verification from a name or claim', () => {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { AgentCard } from './src/components/AgentCard.tsx';
    globalThis.React = React;
    const html = renderToStaticMarkup(React.createElement(AgentCard, { agent: {
      id: '56-999999999', chainId: 56, tokenId: '999999999', category: null,
      name: 'Agripinaa Steward <img src=x onerror=alert(1)>',
      description: '<script>alert(1)</script>', claimed: true, claimedFields: ['description'],
      trust: { isVerified: false, totalScore: null, totalFeedbacks: 0 },
    } }));
    assert.doesNotMatch(html, /<script|<img|Verified by Agripinaa/);
    assert.doesNotMatch(html, /card-visual|data-agent=/, 'owner text cannot acquire a first-party visual identity');
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script/);
    assert.match(html, /owner-provided: description/);
    assert.ok(html.includes('href="/agent/56/999999999"'));
    assert.match(html, /class="agent-card group min-w-0"/, 'cards must shrink in implicit mobile grid tracks');
    assert.match(html, /<h3[^>]*class="min-w-0 truncate /, 'untrusted names must stay bounded');
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
