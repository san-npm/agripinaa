import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { listAgents } from "@/lib/data";

async function Directory() {
  const page = await listAgents(undefined, 48);
  return (
    <>
      <p className="mb-6 text-sm text-zinc-500">
        {page.total != null
          ? `${page.total.toLocaleString()} agents registered on BNB Smart Chain`
          : `${page.items.length} agents shown`}{" "}
        · source: {page.source}
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {page.items.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </>
  );
}

export default function AgentsPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">All agents</h1>
      <Suspense fallback={<p className="text-zinc-500">Loading agents…</p>}>
        <Directory />
      </Suspense>
    </div>
  );
}
