import { CATEGORIES, type Category } from "@agripinaa/agent-index";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { ArrowIcon, CATEGORY_ICON } from "@/components/icons";
import { CATEGORY_INFO } from "@/lib/categories";
import { listAgents } from "@/lib/data";

export function generateStaticParams() {
  return CATEGORIES.map((category) => ({ category }));
}

async function CategoryAgents({ category }: { category: Category }) {
  const page = await listAgents(category, 24);
  if (page.items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-strong bg-surface p-8 text-center">
        <p className="text-sm text-muted">
          No agents classified in this category yet.
        </p>
        <p className="mt-1 text-xs text-muted-2">
          Agents that declare a <code className="text-muted">category</code> in
          their ERC-8004 metadata appear here automatically.
        </p>
      </div>
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
  const Icon = CATEGORY_ICON[match];

  return (
    <div>
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted-2 transition-colors hover:text-foreground"
      >
        <ArrowIcon className="h-3.5 w-3.5 rotate-180" /> All categories
      </Link>
      <div className="flex items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
          <Icon className="h-6 w-6" />
        </span>
        <div>
          <h1 className="font-display text-2xl font-semibold">{info.label}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            {info.explainer}
          </p>
        </div>
      </div>
      <div className="mt-8">
        <Suspense
          fallback={<p className="text-sm text-muted-2">Loading agents…</p>}
        >
          <CategoryAgents category={match} />
        </Suspense>
      </div>
    </div>
  );
}
