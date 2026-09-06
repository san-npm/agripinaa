import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

import { Toaster } from "@/components/Toaster";
import { SITE_URL } from "@/lib/site";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});
const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const DESCRIPTION =
  "Discover, evaluate, and hire ERC-8004 AI agents on BNB Smart Chain, with provable on-chain execution quality.";

export const metadata: Metadata = {
  // Lets the file-based opengraph-image and every relative metadata URL below
  // resolve to an absolute one, which link previews require.
  metadataBase: new URL(SITE_URL),
  title: "Agripinaa: the front door for every agent on BSC",
  description: DESCRIPTION,
  applicationName: "Agripinaa",
  openGraph: {
    type: "website",
    siteName: "Agripinaa",
    url: SITE_URL,
    title: "Agripinaa: the front door for every agent on BSC",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Agripinaa: the front door for every agent on BSC",
    description: DESCRIPTION,
  },
};

function Logo() {
  return <span className="brand">
    <span aria-hidden className="brand-mark"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 16 10 3l7 13M6 11h8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg></span>
    Agripinaa
  </span>;
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:block focus:bg-surface focus:p-3">Skip to content</a>
        <header className="site-header">
          <nav aria-label="Main navigation" className="site-container site-nav">
            <Link href="/" aria-label="Agripinaa home"><Logo /></Link>
            <Suspense fallback={<Link href="/dashboard" className="button-primary nav-account">My agents</Link>}><SiteNav /></Suspense>
          </nav>
        </header>
        <main id="main-content" tabIndex={-1} className="site-container flex-1 py-10 sm:py-14">{children}</main>
        <footer className="site-footer">
          <div className="site-container grid gap-6 sm:grid-cols-[1fr_2fr] text-xs text-muted-2">
            <div><Logo /><p className="mt-3">Independent strategies. Transparent execution.</p><p className="mt-1">Built on BNB Smart Chain.</p></div>
            <div>
              <div className="mb-4 flex flex-wrap gap-5 text-sm text-foreground">
                <Link href="/agents">Explore agents</Link><Link href="/dashboard">My agents</Link><Link href="/funds">Security</Link><Link href="/proof">Activity</Link>
              </div>
              <p>Trade execution powered by <a href="https://ophis.fi" className="underline underline-offset-2">Ophis</a>. Identity and reputation from ERC-8004 registries on BNB Smart Chain. Trust is reputation-based; no validation registry is deployed yet. Open source under MIT.</p>
              <p className="mt-2">DeFi involves risk. Returns are variable, and fees reduce the amount invested.</p>
            </div>
          </div>
        </footer>
        <Toaster />
      </body>
    </html>
  );
}
