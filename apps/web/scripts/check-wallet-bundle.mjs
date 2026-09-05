import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import acorn from 'next/dist/compiled/acorn/acorn.js';

// Check emitted code, not node_modules: a restored webpack cache previously
// shipped the old SDK even though source-level tests exercised the patch.
const origin = process.argv[2];
const sources = [];
if (origin) {
  const page = await fetch(new URL('/agent/56/307487/activate', origin));
  assert.equal(page.status, 200);
  const html = await page.text();
  const paths = new Set([...html.matchAll(/src="([^\"]+\.js[^\"]*)"/g)].map((match) => match[1]));
  for (const path of paths) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200);
    sources.push([path, await response.text()]);
  }
} else {
  const root = resolve('.next/static/chunks');
  for (const path of await readdir(root, { recursive: true })) {
    if (path.endsWith('.js')) sources.push([path, await readFile(resolve(root, path), 'utf8')]);
  }
}

function* nodes(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type) yield value;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) yield* nodes(item);
    } else if (child && typeof child === 'object') yield* nodes(child);
  }
}

let checked = 0;
for (const [path, source] of sources) {
  if (!source.includes('"PENDING"') || !source.includes('"FAILED"')) continue;
  for (const node of nodes(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }))) {
    if (node.type !== 'FunctionDeclaration' || !node.async || node.params.length !== 4) continue;
    if (!node.body.body.some((statement) => ['WhileStatement', 'ForStatement'].includes(statement.type))) continue;
    const code = source.slice(node.start, node.end);
    if (!code.includes('"PENDING"') || !code.includes('"FAILED"')) continue;
    const statusRead = [...nodes(node)].find((child) => child.type === 'AwaitExpression'
      && child.argument.type === 'CallExpression' && child.argument.callee.type === 'Identifier');
    assert.ok(statusRead, `Cannot locate SDK status reader in ${path}`);
    for (const status of [300, 400, 500, 201]) {
      const result = await runInNewContext(`(${code})(null, "test-call", 50, 0)`, {
        [statusRead.argument.callee.name]: async () => ({
          status, receipts: [{ transactionHash: 'test-transaction' }],
        }),
        Date, Promise, setTimeout,
      }, { timeout: 1_000 });
      assert.equal(result.status, status === 201 ? 'CONFIRMED' : 'FAILED',
        `${path}: emitted SDK misclassifies relay status ${status}`);
    }
    checked += 1;
  }
}
assert.ok(checked > 0, 'No emitted SDK status poller found; update the bundle check before shipping.');
console.log(`Wallet bundle check passed (${checked} poller${checked === 1 ? '' : 's'}).`);
