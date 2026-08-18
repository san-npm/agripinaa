import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});
const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Agripinaa — the front door for every agent on BSC",
  description:
    "Discover, evaluate, and hire ERC-8004 AI agents on BNB Smart Chain, with provable on-chain execution quality.",
};

function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="inline-block h-5 w-5 rounded-sm bg-gradient-to-br from-[var(--primary-050)] to-[var(--primary)] shadow-[0_0_12px_rgba(245,158,11,0.5)]"
      />
      <span className="font-display text-base font-semibold tracking-tight">
        Agripinaa
      </span>
    </span>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrains.variable} h-full`}
    >
      <body className="min-h-full flex flex-col">
        <header className="sticky top-0 z-40 border-b border-border bg-[color:var(--background)]/80 backdrop-blur-md">
          <nav className="relative mx-auto flex max-w-6xl items-center gap-6 px-4 py-3.5 text-sm">
            <Link href="/" className="hover:opacity-90">
              <Logo />
            </Link>
            <Link
              href="/agents"
              className="text-muted transition-colors hover:text-foreground"
            >
              Agents
            </Link>
            <Link
              href="/dashboard"
              className="text-muted transition-colors hover:text-foreground"
            >
              My sessions
            </Link>
            <span className="ml-auto flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted">
              <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-success" />
              BNB Smart Chain
            </span>
          </nav>
        </header>
        <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 py-10">
          {children}
        </main>
        <footer className="relative z-10 border-t border-border">
          <div className="mx-auto max-w-6xl space-y-2 px-4 py-8 text-xs text-muted-2">
            <p>
              Execution powered by{" "}
              <a
                href="https://ophis.fi"
                className="text-muted underline decoration-border-strong underline-offset-2 hover:text-foreground"
              >
                Ophis
              </a>
              . Trades routed through Ophis carry its standard partner fee
              (5&nbsp;bps volume, 1&nbsp;bp on stable pairs). Agripinaa takes no
              fee.
            </p>
            <p>
              Identity and reputation from ERC-8004 registries on BNB Smart
              Chain. Trust is reputation-based: no validation registry is
              deployed yet. Open source under MIT.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
