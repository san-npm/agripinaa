// Read-only browser review. Start local Next.js and a fresh headless Chrome
// profile with --remote-debugging-port=9333, then run this file with Node 22+.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.UI_REVIEW_URL ?? 'http://127.0.0.1:3100';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Review only a local preview');
const target = await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error) call.reject(new Error(message.error.message));
  else call.resolve(message.result);
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 60_000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = join(tmpdir(), 'agripinaa-ui-review');
mkdirSync(output, { recursive: true });
await cdp('Page.enable');
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
try {
  for (const width of [1440, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 640 });
    for (const [name, route] of [
      ['home', '/'], ['agents', '/agents'], ['profile', '/agent/56/307487'],
      ['activation', '/agent/56/307487/activate'], ['dashboard', '/dashboard'], ['category', '/c/yield'],
      ['search', '/agents?q=steward'],
      ['summary-search', '/agents?q=preset+price+levels'],
      ['activity', '/proof'], ['performance', '/leaderboard'], ['security', '/funds'],
    ]) {
      await cdp('Page.navigate', { url: base + route });
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('h1')`)) break;
        await delay(500);
      }
      await evaluate('document.fonts.ready.then(() => true)');
      await delay(500);
      const page = await evaluate(`({ title: document.title, heading: document.querySelector('h1')?.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        background: getComputedStyle(document.body).backgroundColor,
        main: !!document.querySelector('#main-content'),
        bad: !!document.querySelector('nextjs-portal')?.shadowRoot?.querySelector('[data-nextjs-dialog]') })`);
      assert.ok(page.heading, `${name}: missing heading`);
      assert.equal(page.overflow, false, `${name} at ${width}px overflows`);
      assert.equal(page.main, true, `${name}: missing skip-link destination`);
      assert.equal(page.bad, false, `${name}: Next.js error overlay`);
      if (name === 'search' || name === 'summary-search') {
        const names = await evaluate(`Array.from(document.querySelectorAll('main section:first-of-type .agent-card h3'), el => el.textContent)`);
        assert.deepEqual(names, [name === 'search' ? 'Agripinaa Steward' : 'Agripinaa Grid'], 'Search must include displayed strategy summaries');
        assert.equal(await evaluate(`document.querySelector('main').textContent.includes('No agents match')`), false, 'Independent empty state must not contradict first-party matches');
      }
      if (name === 'agents' || name === 'category') {
        assert.equal(await evaluate(`(() => {
          const heading = document.querySelector('.agent-card h3');
          const original = heading.textContent;
          try {
            heading.textContent = 'X'.repeat(2000);
            return heading.getBoundingClientRect().right <= heading.closest('.agent-card').getBoundingClientRect().right
              && document.documentElement.scrollWidth <= innerWidth + 1;
          } finally { heading.textContent = original; }
        })()`), true, 'Unbroken registry names must stay inside their card');
      }
      if (name === 'dashboard') {
        assert.equal(await evaluate(`document.querySelector('main details')?.open`), false, 'Recovery should be available without dominating the dashboard');
        await evaluate(`document.querySelector('main details > summary').click()`);
        assert.equal(await evaluate(`document.querySelector('main details').open`), true, 'Recovery remains accessible');
        await evaluate(`document.querySelector('main details > summary').click()`);
      }
      if (name === 'activation') {
        assert.equal(await evaluate(`document.querySelectorAll('ol[aria-label="Activation progress"] li').length`), 3);
        assert.equal(await evaluate(`document.querySelector('li[aria-current="step"]').textContent.trim()`), '1Account');
      }
      if (width < 640 && name === 'home') {
        await evaluate(`document.querySelector('.mobile-nav summary').focus(); document.querySelector('.mobile-nav summary').click()`);
        assert.equal(await evaluate(`document.querySelector('.mobile-nav').open`), true);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mobile-nav .nav-links')).display !== 'none'`), true);
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        assert.equal(await evaluate(`document.querySelector('.mobile-nav').open`), false, 'Escape closes navigation');
      }
      const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = join(output, `${name}-${width}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(JSON.stringify({ name, width, ...page, screenshot: file }));
    }
  }
} finally {
  ws.close();
  await fetch(`http://127.0.0.1:9333/json/close/${target.id}`);
}
