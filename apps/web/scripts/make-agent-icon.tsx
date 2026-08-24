/**
 * Regenerates `public/agent-icon.png`.
 *
 * Every ERC-8004 manifest this site serves points its `image` field at
 * https://agripinaa.vercel.app/agent-icon.png, and that URL is baked into
 * on-chain registrations, so the file has to exist and has to stay at that
 * path. It is generated rather than hand-authored so the mark stays in step
 * with the globals.css tokens; re-run after a palette change:
 *
 *   pnpm --filter @agripinaa/web gen:icon
 *
 * Satori resolves no CSS custom properties, so the tokens are written out as
 * literals here (deep void #0b0f1a, amber-gold #f59e0b / #fbbf24).
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ImageResponse } from "next/og";

const SIZE = 512;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "agent-icon.png");

const icon = (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#0b0f1a",
      position: "relative",
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 56,
        left: 56,
        width: 400,
        height: 400,
        borderRadius: 400,
        background:
          "radial-gradient(circle at 50% 45%, rgba(245,158,11,0.34), rgba(11,15,26,0) 70%)",
      }}
    />
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 288,
        height: 288,
        borderRadius: 72,
        background: "linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 152,
          height: 152,
          borderRadius: 40,
          background: "#0b0f1a",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 56,
            height: 56,
            borderRadius: 16,
            background: "linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)",
          }}
        />
      </div>
    </div>
  </div>
);

async function main(): Promise<void> {
  const png = Buffer.from(
    await new ImageResponse(icon, { width: SIZE, height: SIZE }).arrayBuffer(),
  );
  await writeFile(OUT, png);
  console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.byteLength} bytes)`);
}

void main();
