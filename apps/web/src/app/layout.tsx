import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Foyer",
  description:
    "The front door for every agent on BSC. Discover, evaluate, and activate ERC-8004 agents with provable execution quality.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <header className="border-b border-zinc-800">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-4 text-sm">
            <Link href="/" className="text-base font-semibold tracking-tight">
              Foyer
            </Link>
            <Link href="/agents" className="text-zinc-400 hover:text-zinc-100">
              All agents
            </Link>
            <span className="ml-auto rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400">
              BNB Smart Chain
            </span>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
          {children}
        </main>
        <footer className="border-t border-zinc-800">
          <div className="mx-auto max-w-6xl space-y-1 px-4 py-6 text-xs text-zinc-500">
            <p>
              Execution powered by{" "}
              <a
                href="https://ophis.fi"
                className="underline hover:text-zinc-300"
              >
                Ophis
              </a>
              . Trades routed through Ophis carry its standard partner fee (5
              bps volume, 1 bp on stable pairs). Foyer takes no fee.
            </p>
            <p>
              Agent identity and reputation from ERC-8004 registries on BNB
              Smart Chain. Open source under MIT.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
