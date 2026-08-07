import { CATEGORIES, type Category } from "@foyer/agent-index";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { CATEGORY_INFO } from "@/lib/categories";
import { listAgents } from "@/lib/data";

export function generateStaticParams() {
  return CATEGORIES.map((category) => ({ category }));
}

async function CategoryAgents({ category }: { category: Category }) {
  const page = await listAgents(category, 24);
  if (page.items.length === 0) {
    return (
      <p className="text-zinc-500">
        No agents classified in this category yet. Agents declaring a{" "}
        <code className="text-zinc-400">category</code> field in their ERC-8004
        metadata appear here automatically.
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {page.items.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

export default async function CategoryPage({
  params,
}: PageProps<"/c/[category]">) {
  const { category } = await params;
  const match = CATEGORIES.find((c) => c === category);
  if (!match) notFound();
  const info = CATEGORY_INFO[match];

  return (
    <div>
      <h1 className="text-2xl font-semibold">{info.label}</h1>
      <p className="mt-3 max-w-2xl text-zinc-400">{info.explainer}</p>
      <div className="mt-8">
        <Suspense fallback={<p className="text-zinc-500">Loading agents…</p>}>
          <CategoryAgents category={match} />
        </Suspense>
      </div>
    </div>
  );
}
