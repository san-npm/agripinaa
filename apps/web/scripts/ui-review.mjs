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
  for (const width of [1440, 768, 390, 320]) {
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
      if (name === 'home') {
        const sharePath = await evaluate(`new URL(document.querySelector('meta[property="og:image"]').content).pathname`);
        assert.equal(sharePath, '/opengraph-image.png', 'Share metadata uses the static brand card');
        const share = await fetch(base + sharePath);
        assert.equal(share.status, 200, 'Share card must load over HTTP');
        assert.equal(Buffer.from(await share.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
        const studioCount = await evaluate(`document.querySelectorAll('.studio-selectors button').length`);
        assert.equal(studioCount, 8, 'Every registered strategy has a selectable preview');
        const palettes = new Set();
        const silhouettes = new Set();
        for (let choice = 0; choice < studioCount; choice++) {
          await evaluate(`document.querySelectorAll('.studio-selectors button')[${choice}].click()`);
          for (let attempt = 0; attempt < 40; attempt++) {
            if (await evaluate(`document.querySelector('.studio-stage').dataset.agent === document.querySelectorAll('.studio-selectors button')[${choice}].dataset.agent`)) break;
            await delay(50);
          }
          await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
          const selection = await evaluate(`(() => {
            const selected = document.querySelector('.studio-selectors button[aria-pressed="true"]');
            const stage = document.querySelector('.studio-stage');
            return { selected: selected.dataset.agent, shown: stage.dataset.agent, fill: getComputedStyle(stage).backgroundColor,
              shape: stage.querySelector('.art-object')?.getAttribute('src'),
              link: document.querySelector('.studio-detail a').getAttribute('href'), art: stage.querySelectorAll('img.art-object').length };
          })()`);
          assert.equal(selection.selected, selection.shown, 'Selected agent and visible artwork stay aligned');
          assert.equal(await evaluate(`document.querySelectorAll('.studio-selectors button')[${choice}].getAttribute('aria-pressed')`), 'true', 'Clicked preview becomes selected');
          assert.ok(selection.art > 0, 'Each agent has artwork');
          await evaluate(`document.querySelector('.studio-stage img.art-object').decode().then(() => true)`);
          assert.match(selection.link, /^\/agent\/56\/\d+$/, 'Preview leads to a registered profile, not funding');
          palettes.add(selection.fill);
          silhouettes.add(selection.shape);
        }
        assert.equal(palettes.size, 8, 'Agent identities must be visually distinct');
        assert.equal(silhouettes.size, 8, 'Each agent has a different silhouette, not just a different color');
        await evaluate(`document.querySelector('.studio-selectors button').click()`);
        await delay(100);
        assert.equal(await evaluate(`document.querySelectorAll('.home-hero .bloub-logo').length`), 0, 'No standalone hero mascot');
        assert.equal(await evaluate(`document.querySelectorAll('.bloub-logo').length`), 2, 'Brand marks in header and footer only');
        assert.equal(await evaluate(`document.querySelectorAll('a button').length`), 0, 'Home links never contain animation controls');
        for (const region of ['.site-header', '.site-footer']) {
          assert.ok((await evaluate(`document.querySelector('${region} picture img').currentSrc`)).endsWith('neutre-orange.svg'), 'Reduced motion uses a still SVG');
        }
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        for (const region of ['.site-header', '.site-footer']) {
          for (let attempt = 0; attempt < 40; attempt++) {
            if (await evaluate(`(() => { const img = document.querySelector('${region} picture img'); return img.currentSrc.endsWith('-anime.svg') && img.complete && img.naturalWidth > 0; })()`)) break;
            await delay(50);
          }
          await evaluate(`document.querySelector('${region} picture img').decode().then(() => true)`);
          assert.ok((await evaluate(`document.querySelector('${region} picture img').currentSrc`)).endsWith('-anime.svg'), 'Both brand marks animate');
        }
        if (width === 1440) {
          const expressions = new Set();
          for (let step = 0; step < 5; step++) {
            expressions.add(await evaluate(`document.querySelector('.site-header picture img').currentSrc`));
            if (step < 4) await delay(6100);
          }
          assert.equal(expressions.size, 5, 'All five eye expressions cycle');
        }
        for (const region of ['.site-header', '.site-footer']) {
          await evaluate(`document.querySelector('${region} .mascot-toggle').click()`);
          await delay(100);
          assert.ok((await evaluate(`document.querySelector('${region} picture img').currentSrc`)).endsWith('neutre-orange.svg'), 'Pause uses a genuinely still SVG');
          await evaluate(`document.querySelector('${region} .mascot-toggle').click()`);
          await delay(100);
          assert.ok((await evaluate(`document.querySelector('${region} picture img').currentSrc`)).endsWith('-anime.svg'), 'Play restores animation');
        }
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const action = await evaluate(`(() => {
          const s = getComputedStyle(document.querySelector('.home-hero .button-primary'));
          const luminance = rgb => rgb.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => {
            v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
          }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const a = luminance(s.color), b = luminance(s.backgroundColor);
          return { contrast: (Math.max(a,b) + .05) / (Math.min(a,b) + .05), radius: parseFloat(s.borderRadius), fill: s.backgroundColor };
        })()`);
        assert.ok(action.contrast >= 4.5, 'Primary action text must have accessible contrast');
        assert.ok(action.radius <= 6, 'Controls must retain restrained corners');
        assert.equal(action.fill, 'rgb(255, 178, 26)', 'Primary actions retain the amber identity');
      }
      assert.equal(await evaluate(`document.querySelector('main').textContent.toLowerCase().includes('strategy illustration')`), false, 'No placeholder art captions');
      const brokenImages = await evaluate(`Promise.all(Array.from(document.querySelectorAll('img'), async img => {
        // Check lazy images too, without triggering unrelated page actions.
        try { img.loading = 'eager'; await img.decode(); return img.naturalWidth ? null : img.src; } catch { return img.src; }
      })).then(results => results.filter(Boolean))`);
      assert.deepEqual(brokenImages, [], name + ': every bundled image must load');
      if (name === 'search' || name === 'summary-search') {
        const names = await evaluate(`Array.from(document.querySelectorAll('main section:first-of-type .agent-card h3'), el => el.textContent)`);
        assert.deepEqual(names, [name === 'search' ? 'Agripinaa Steward' : 'Agripinaa Grid'], 'Search must include displayed strategy summaries');
        assert.equal(await evaluate(`document.querySelector('main').textContent.includes('No agents match')`), false, 'Independent empty state must not contradict first-party matches');
      }
      if (name === 'agents' || name === 'category') {
        const grid = await evaluate(`(() => {
          const g = getComputedStyle(document.querySelector('.agent-grid'));
          return { columns: g.gridTemplateColumns.split(' ').length, gap: parseFloat(g.gap), radius: parseFloat(getComputedStyle(document.querySelector('.agent-card')).borderRadius) };
        })()`);
        assert.equal(grid.columns, width >= 1024 ? 3 : width >= 640 ? 2 : 1, 'Directory grids share responsive tracks');
        assert.equal(grid.gap, 24, 'Directory grids share a 24px gutter');
        assert.ok(grid.radius <= 8, 'Cards must retain restrained corners');
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
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.nav-account')).display !== 'none'`), true, 'My agents stays directly accessible on mobile');
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
