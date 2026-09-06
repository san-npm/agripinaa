import Link from "next/link";
import { Suspense } from "react";
import { AgentCard } from "@/components/AgentCard";
import { ArrowIcon, CATEGORY_ICON } from "@/components/icons";
import { ProofFeed } from "@/components/ProofFeed";
import { ProofFeedLive } from "@/components/ProofFeedLive";
import { CATEGORY_INFO } from "@/lib/categories";
import { listFirstParty } from "@/lib/data";

async function FeaturedAgents() {
  const agents = await listFirstParty();
  if (agents.length === 0) return <p className="text-muted">Strategies are temporarily unavailable. Please check again shortly.</p>;
  return <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
    {agents.slice(0, 6).map(agent => <AgentCard key={agent.id} agent={agent} />)}
  </div>;
}

const goals = [
  { category: "yield" as const, title: "Earn lending yield", copy: "Compare rates across Aave and Venus." },
  { category: "grid" as const, title: "Automate a trading strategy", copy: "Trade within predefined price levels." },
  { category: "health-factor" as const, title: "Monitor borrowing risk", copy: "Keep a reserve ready to repay debt." },
  { category: "rebalancing" as const, title: "Manage liquidity", copy: "Maintain a concentrated-liquidity range." },
];

export default function Home() {
  return <div>
    <section className="home-hero">
      <div>
        <p className="eyebrow">Your on-chain strategy, simplified</p>
        <h1>Put your assets <br /><span>to work. On your terms.</span></h1>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
          Discover automated DeFi strategies, understand what each agent can do,
          and stay in control of your account.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/agents" className="button-primary">Explore agents <ArrowIcon className="h-4 w-4" /></Link>
          <Link href="/dashboard" className="button-secondary">My agents</Link>
        </div>
        <p className="mt-5 text-xs text-muted-2">BNB Smart Chain · Passkey access · Revocable permissions</p>
      </div>
      <div className="journey-panel">
        <p className="eyebrow">A clear path from choice to control</p>
        <ol className="mt-3">
          {[
            ["Choose your strategy", "Review its approach, permissions and on-chain activity."],
            ["Review and activate", "Create or recover your account. See the funding split before you approve."],
            ["Follow your agent", "Check balances, inspect activity and stop the agent from your dashboard."],
          ].map(([title, copy], index) => <li key={title}>
            <span aria-hidden className="journey-number">0{index + 1}</span>
            <div><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-sm text-muted">{copy}</p></div>
          </li>)}
        </ol>
      </div>
    </section>

    <section className="border-y border-border py-8">
      <p className="eyebrow mb-5">What would you like to do?</p>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {goals.map(({category, title, copy}) => {
          const Icon = CATEGORY_ICON[category];
          return <Link key={category} href={`/c/${category}`} className="group flex gap-3 rounded-md py-1">
            <Icon className="mt-1 h-5 w-5 shrink-0 text-primary" />
            <div><h2 className="text-sm font-semibold group-hover:underline">{title} <span aria-hidden>↗</span></h2><p className="mt-1 text-xs text-muted">{copy}</p><span className="sr-only">{CATEGORY_INFO[category].label}</span></div>
          </Link>;
        })}
      </div>
    </section>

    <section className="mt-14">
      <div className="section-heading">
        <div><p className="eyebrow mb-2">Built by Agripinaa</p><h2>Find an approach that fits.</h2><p className="mt-2 text-sm text-muted">Distinct strategies, clear permissions, and activity you can inspect.</p></div>
        <Link href="/agents" className="text-sm font-semibold text-primary">View all agents <span aria-hidden>↗</span></Link>
      </div>
      <Suspense fallback={<p className="rounded-lg border border-border bg-surface p-8 text-muted">Loading strategies…</p>}><FeaturedAgents /></Suspense>
    </section>

    <section className="mt-14 grid gap-8 rounded-xl bg-surface-2 p-6 sm:p-8 lg:grid-cols-[1fr_2fr]">
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
