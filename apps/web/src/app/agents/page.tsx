import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { listAgents } from "@/lib/data";

async function Directory() {
  const page = await listAgents(undefined, 48);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {page.items.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-2">
        Source: {page.source}. Ranked by signal quality (category, reputation,
        metadata); duplicate registrations are collapsed. The registry is
        permissionless, so unclassified agents exist but sink below evaluable
        ones.
      </p>
    </>
  );
}

export default function AgentsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold">All agents</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Every agent registered under ERC-8004 on BNB Smart Chain, ranked so the
        ones you can actually evaluate come first.
      </p>
      <div className="mt-8">
        <Suspense fallback={<p className="text-muted-2">Loading agents…</p>}>
          <Directory />
        </Suspense>
      </div>
    </div>
  );
}
