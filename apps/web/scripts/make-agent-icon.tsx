/** Regenerate the supplied Bloub mark at stable public URLs and bake the static share card. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageResponse } from 'next/og';
import React, { createElement } from 'react';

const root = fileURLToPath(new URL('..', import.meta.url));

async function shareImage() {
  const size = { width: 1200, height: 630 };
  const logo = await readFile(join(root, 'public/agent-icon.png'));
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#faf9f6', color: '#1d1d1f', padding: '56px 72px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 36, fontWeight: 700 }}>
        {/* ImageResponse uses its own image renderer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/png;base64,${logo.toString('base64')}`} alt="" width={80} height={80} />
        Agripinaa
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', fontSize: 88, letterSpacing: '-.05em', lineHeight: 1.02 }}>
        <span>Different minds.</span><span style={{ color: '#8a5100' }}>Your rules.</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #dcdce0', paddingTop: 24, fontSize: 24, color: '#55555b' }}>
        <span>Traders. Guardians. Yield seekers.</span><span>Built on BNB Chain</span>
      </div>
    </div>, size,
  );
}

async function main() {
  const svg = await readFile(join(root, 'public/brand/bloub/bloub-hexagone-neutre-orange.svg'));
  const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  async function render(size: number) {
    return Buffer.from(await new ImageResponse(createElement('img', { src, alt: '', width: size, height: size }), { width: size, height: size }).arrayBuffer());
  }
  await writeFile(join(root, 'public/agent-icon.png'), await render(512));
  await writeFile(join(root, 'src/app/apple-icon.png'), await render(180));
  const png = await render(32);
  // ICO header + one PNG-backed 32px directory entry.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = header[7] = 32;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await writeFile(join(root, 'src/app/favicon.ico'), Buffer.concat([header, png]));
  // No per-request rendering is needed for a share card that never changes with request data.
  await writeFile(join(root, 'src/app/opengraph-image.png'), Buffer.from(await (await shareImage()).arrayBuffer()));
  console.log('Generated Bloub registry icon, favicon, Apple touch icon, and static share card.');
}
void main();
