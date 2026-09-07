import Link from "next/link";
import { Suspense } from "react";
import { AgentCard } from "@/components/AgentCard";
import { AgentStudio } from "@/components/AgentStudio";
import { ProtocolLogo } from "@/components/ProtocolLogo";
import { ArrowIcon, CATEGORY_ICON } from "@/components/icons";
import { ProofFeed } from "@/components/ProofFeed";
import { ProofFeedLive } from "@/components/ProofFeedLive";
import { CATEGORY_INFO } from "@/lib/categories";
import { listFirstParty } from "@/lib/data";

async function FeaturedAgents() {
  const agents = await listFirstParty();
  if (agents.length === 0) return <p className="text-muted">Strategies are temporarily unavailable. Please check again shortly.</p>;
  return <div className="agent-grid">
    {agents.map(agent => <AgentCard key={agent.id} agent={agent} />)}
  </div>;
}

const goals = [
  { category: "yield" as const, title: "Earn lending yield", copy: "Compare rates across Aave and Venus." },
  { category: "grid" as const, title: "Automate trades", copy: "Trade at preset price levels." },
  { category: "health-factor" as const, title: "Monitor borrowing risk", copy: "Keep a reserve ready to repay debt." },
  { category: "rebalancing" as const, title: "Manage liquidity", copy: "Maintain a concentrated-liquidity range." },
];

export default function Home() {
  return <div>
    <section className="home-hero collection-hero">
      <div className="hero-copy">
        <p className="eyebrow">AGRIPINAA / ON-CHAIN AGENTS</p>
        <h1>Different<br />minds.<br /><span>Your rules.</span></h1>
        <p className="hero-description">
          Traders. Guardians. Yield seekers.<br />Find the agent that thinks your way.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/agents" className="button-primary">Find your agent <ArrowIcon className="h-4 w-4" /></Link>
          <Link href="#collection" className="hero-secondary">Explore the collection <span aria-hidden>↓</span></Link>
        </div>
        <p className="hero-footnote">Built on BNB Chain. You approve the limits.</p>
      </div>
      <AgentStudio />
    </section>

    <section className="ecosystem-strip" aria-label="Infrastructure used by Agripinaa strategies">
      <div><p className="eyebrow">Built on</p><ProtocolLogo protocol="bnb-chain" /></div>
      <div><p className="eyebrow">Protocols used</p><div className="ecosystem-protocols">{(['aave', 'venus', 'pancakeswap', 'ophis'] as const).map(protocol => <ProtocolLogo key={protocol} protocol={protocol} />)}</div></div>
    </section>
    <section className="border-y border-border py-8">
      <p className="eyebrow mb-5">What would you like to do?</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {goals.map(({category, title, copy}) => {
          const Icon = CATEGORY_ICON[category];
          return <Link key={category} href={`/c/${category}`} className="goal-link group" data-category={category}>
            <Icon className="h-12 w-12 shrink-0 text-primary" />
            <div><h2 className="text-sm font-semibold group-hover:underline">{title} <span aria-hidden>↗</span></h2><p className="mt-1 text-xs text-muted">{copy}</p><span className="sr-only">{CATEGORY_INFO[category].label}</span></div>
          </Link>;
        })}
      </div>
    </section>

    <section id="collection" className="mt-14">
      <div className="section-heading">
        <div><p className="eyebrow mb-2">01 / The collection</p><h2>Not every agent<br />thinks alike.</h2></div>
        <Link href="/agents" className="text-sm font-semibold text-primary">View all agents <span aria-hidden>↗</span></Link>
      </div>
      <Suspense fallback={<p className="rounded-lg border border-border bg-surface p-8 text-muted">Loading strategies…</p>}><FeaturedAgents /></Suspense>
    </section>

    <section className="control-manifesto mt-14 grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_2fr]">
      <div><p className="eyebrow mb-2">Know what you approve</p><h2 className="text-2xl font-medium">Control is part<br />of the product.</h2><Link href="/funds" className="mt-5 inline-block text-sm font-semibold text-primary underline underline-offset-4">Read about security</Link></div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div><h3 className="font-semibold">Permissions, not your main wallet</h3><p className="mt-2 text-sm text-muted">An agent receives limited, time-bound authority for its strategy account. Review the scope before activation.</p></div>
        <div><h3 className="font-semibold">A visible funding split</h3><p className="mt-2 text-sm text-muted">Activation fees and the gas reserve are separate from strategy capital. Returns are variable and never guaranteed.</p></div>
      </div>
    </section>

    <section className="mt-14">
      <div className="section-heading"><div><p className="eyebrow mb-2">Traceable, not self-reported</p><h2>On-chain activity</h2></div><Link href="/proof" className="text-sm font-semibold text-primary">View activity <span aria-hidden>↗</span></Link></div>
      <Suspense fallback={<ProofFeed compact />}><ProofFeedLive compact /></Suspense>
    </section>
  </div>;
}
