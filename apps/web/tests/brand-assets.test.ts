import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_LIST } from '@agripinaa/shared/agents';
import { agentExperience } from '../src/lib/agent-experience';
import { tokenLogoAsset } from '../src/lib/token-logo-assets';

const publicDir = join(import.meta.dirname, '../public');

test('every configured strategy has a distinct real PNG, assets, and local protocol marks', async () => {
  const images = new Set<string>();
  for (const agent of AGENT_LIST) {
    const png = await readFile(join(publicDir, 'agents', `${agent.slug}.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    images.add(png.toString('base64'));
    const execution = agent.manifest.execution;
    for (const token of execution.pair?.split('/') ?? [execution.asset ?? 'USDT']) {
      const path = tokenLogoAsset(token);
      assert.ok(path, `${agent.slug}: unsupported strategy asset ${token}`);
      await readFile(join(publicDir, path));
    }
    for (const protocol of agentExperience(agent.slug).protocols) {
      assert.match(await readFile(join(publicDir, 'protocols', `${protocol}.svg`), 'utf8'), /<svg/);
    }
  }
  assert.equal(images.size, AGENT_LIST.length);
  assert.deepEqual(agentExperience('health-factor').protocols, ['aave']);
  assert.deepEqual(agentExperience('venus-guardian').protocols, ['venus']);
  assert.deepEqual(agentExperience('yield-b').protocols, ['aave', 'venus']);
  assert.deepEqual(agentExperience('lp-range').protocols, ['pancakeswap', 'ophis']);
});

test('bundled brand SVGs contain no executable content or external resources', async () => {
  for (const folder of ['brand/bloub', 'protocols', 'tokens']) {
    for (const name of (await readdir(join(publicDir, folder))).filter(name => name.endsWith('.svg'))) {
      const svg = await readFile(join(publicDir, folder, name), 'utf8');
      assert.doesNotMatch(svg, /<script|<foreignObject|\bon\w+\s*=|(?:href|src)\s*=|@import|url\(\s*["']?(?!#)[^)]/i, name);
    }
  }
});

test('brand icons retain the registered image URL and contain valid image data', async () => {
  for (const path of [join(publicDir, 'agent-icon.png'), join(import.meta.dirname, '../src/app/apple-icon.png'), join(import.meta.dirname, '../src/app/opengraph-image.png')]) {
    assert.equal((await readFile(path)).subarray(1, 4).toString(), 'PNG');
  }
  const ico = await readFile(join(import.meta.dirname, '../src/app/favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.subarray(23, 26).toString(), 'PNG');
});
