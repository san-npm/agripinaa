import { ImageResponse } from "next/og";

export const alt =
  "Agripinaa: the front door for every agent on BNB Smart Chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Share card for every link to the site that does not set its own.
 *
 * Colours are the globals.css tokens by hand, not by variable: satori resolves
 * no CSS custom properties, so a var() here renders as a transparent box.
 * Deep void background, amber-gold mark and rule, one violet glow for the
 * accent, which is the same restraint the site itself uses.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0f1a",
          padding: "72px 80px",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -260,
            right: -140,
            width: 620,
            height: 620,
            borderRadius: 620,
            background:
              "radial-gradient(circle at 50% 50%, rgba(245,158,11,0.26) 0%, rgba(245,158,11,0.06) 45%, rgba(11,15,26,0) 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -220,
            left: 120,
            width: 480,
            height: 480,
            borderRadius: 480,
            background:
              "radial-gradient(circle at 50% 50%, rgba(139,92,246,0.20) 0%, rgba(139,92,246,0.05) 45%, rgba(11,15,26,0) 100%)",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "linear-gradient(135deg, #fbbf24, #f59e0b)",
            }}
          />
          <div
            style={{
              display: "flex",
              fontSize: 40,
              fontWeight: 700,
              color: "#f8fafc",
              letterSpacing: "-0.02em",
            }}
          >
            Agripinaa
          </div>
          <div
            style={{
              display: "flex",
              marginLeft: 16,
              padding: "8px 18px",
              borderRadius: 999,
              border: "1px solid #1e293b",
              background: "#111827",
              fontSize: 22,
              color: "#94a3b8",
            }}
          >
            ERC-8004 · BNB Smart Chain
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 78,
              fontWeight: 700,
              color: "#f8fafc",
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
            }}
          >
            The front door for
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 78,
              fontWeight: 700,
              color: "#f59e0b",
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
            }}
          >
            every agent on BSC
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 30,
              color: "#94a3b8",
              lineHeight: 1.35,
            }}
          >
            Browse on-chain agents, read their execution record, hire one with a
            scoped, revocable session.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", height: 2, background: "#1e293b" }} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 24,
              color: "#64748b",
            }}
          >
            <div style={{ display: "flex" }}>
              Identity and reputation from ERC-8004 registries
            </div>
            <div style={{ display: "flex", color: "#f59e0b" }}>
              agripinaa.vercel.app
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
