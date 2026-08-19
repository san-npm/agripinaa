import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { VerifiedIcon } from "@/components/icons";
import { listDirectory } from "@/lib/data";

async function Directory() {
  const dir = await listDirectory();
  return (
    <>
      {dir.verified.length > 0 && (
        <section className="mb-12">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <VerifiedIcon className="h-4 w-4 text-primary" /> Verified by Agripinaa
          </h2>
          <p className="mb-4 mt-1 text-sm text-muted-2">
            Built, run, and verified on-chain, with execution receipts and an
            ERC-8004 attestation.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {dir.verified.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-display text-lg font-semibold">
          ERC-8004 registry
        </h2>
        <p className="mb-4 mt-1 text-sm text-muted-2">
          Every other agent registered on BNB Smart Chain, ranked by signal
          quality and de-duplicated. These are permissionless registrations:
          discoverable, but their execution is <strong>unverified</strong>. We
          do not vouch for them.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dir.registry.slice(0, 45).map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
        <p className="mt-6 text-xs text-muted-2">
          Source: {dir.registrySource}. Same-name low-signal registrations are
          collapsed into a single card with a count.
        </p>
      </section>
    </>
  );
}

export default function AgentsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold">All agents</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Agents that prove their execution, kept clearly apart from the
        permissionless registry we merely index.
      </p>
      <div className="mt-8">
        <Suspense fallback={<p className="text-muted-2">Loading agents…</p>}>
          <Directory />
        </Suspense>
      </div>
    </div>
  );
}
