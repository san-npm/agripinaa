import { CATEGORIES } from "@foyer/agent-index";
import Link from "next/link";
import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { CATEGORY_INFO } from "@/lib/categories";
import { getStats, listAgents } from "@/lib/data";

async function StatsBar() {
  const stats = await getStats();
  return (
    <p className="text-sm text-zinc-500">
      {stats.totalAgents != null
        ? `${stats.totalAgents.toLocaleString()} agents registered under ERC-8004 across all chains`
        : "Index warming up"}
      {stats.totalFeedbacks != null &&
        ` · ${stats.totalFeedbacks.toLocaleString()} on-chain feedback entries`}{" "}
      · source: {stats.source}
    </p>
  );
}

async function FeaturedAgents() {
  const page = await listAgents(undefined, 6);
  if (page.items.length === 0) return null;
  return (
    <section className="mt-12">
      <h2 className="mb-4 text-lg font-medium">Recently registered</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {page.items.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <div>
      <section className="py-8">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight">
          The front door for every agent on BSC
        </h1>
        <p className="mt-4 max-w-2xl text-zinc-400">
          Browse AI agents registered on-chain under ERC-8004, read their real
          track record, and put one to work with a scoped, revocable session.
          No custody, no blind trust: performance here is provable.
        </p>
        <div className="mt-4">
          <Suspense fallback={<p className="text-sm text-zinc-600">…</p>}>
            <StatsBar />
          </Suspense>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {CATEGORIES.map((category) => {
          const info = CATEGORY_INFO[category];
          return (
            <Link
              key={category}
              href={`/c/${category}`}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 transition hover:border-zinc-500"
            >
              <h2 className="text-xl font-medium">{info.label}</h2>
              <p className="mt-1 text-sm text-zinc-400">{info.blurb}</p>
            </Link>
          );
        })}
      </section>

      <Suspense fallback={null}>
        <FeaturedAgents />
      </Suspense>
    </div>
  );
}
