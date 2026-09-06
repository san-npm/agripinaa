import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

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
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script/);
    assert.match(html, /owner-provided: description/);
    assert.ok(html.includes('href="/agent/56/999999999"'));
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
