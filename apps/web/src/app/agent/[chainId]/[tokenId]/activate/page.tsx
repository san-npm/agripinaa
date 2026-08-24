import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ManagedWizard } from "@/components/ManagedWizard";
import { SessionWizard } from "@/components/SessionWizard";
import { ArrowIcon } from "@/components/icons";
import {
  ACTIVATION_BLOCKED_COPY,
  endpointIsLive,
  isActivatable,
} from "@/lib/activatable";
import { CHAIN_ID, getAgent } from "@/lib/data";

/** Agent categories that manage real user funds (map to a runner agent name). */
const MANAGED_AGENTS: Record<string, string> = { yield: "yield" };

export default function ActivatePage(
  props: PageProps<"/agent/[chainId]/[tokenId]/activate">,
) {
  return (
    <Suspense fallback={<p className="text-muted-2">Loading…</p>}>
      <ActivateContent params={props.params} />
    </Suspense>
  );
}

async function ActivateContent({
  params,
}: {
  params: PageProps<"/agent/[chainId]/[tokenId]/activate">["params"];
}) {
  const { chainId, tokenId } = await params;
  if (Number.parseInt(chainId, 10) !== CHAIN_ID) notFound();
  const agent = await getAgent(tokenId);
  if (!agent) notFound();

  const managedAgent = agent.category ? MANAGED_AGENTS[agent.category] : undefined;

  // Deep links skip the agent page, so the gate lives here too: no wallet step
  // renders for an agent that has nothing behind it.
  if (!isActivatable({ tokenId: agent.tokenId, endpointLive: await endpointIsLive(agent) })) {
    return (
      <div className="max-w-xl">
        <Link
          href={`/agent/${agent.chainId}/${agent.tokenId}`}
          className="mb-6 inline-flex items-center gap-1 text-xs text-muted-2 transition-colors hover:text-foreground"
        >
          <ArrowIcon className="h-3.5 w-3.5 rotate-180" /> Back to {agent.name}
        </Link>
        <div className="rounded-xl border border-border-strong bg-surface p-6">
          <h1 className="font-display text-xl font-semibold">
            {agent.name} cannot be activated
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {ACTIVATION_BLOCKED_COPY}
          </p>
          <Link
            href={`/agent/${agent.chainId}/${agent.tokenId}`}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-2 px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
          >
            Back to the agent page <ArrowIcon className="h-4 w-4" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        aria-hidden
        className="agp-orb pointer-events-none absolute -top-16 right-0 z-0 h-56 w-56 rounded-full opacity-60"
      />
      <Link
        href={`/agent/${agent.chainId}/${agent.tokenId}`}
        className="relative z-10 mb-6 inline-flex items-center gap-1 text-xs text-muted-2 transition-colors hover:text-foreground"
      >
        <ArrowIcon className="h-3.5 w-3.5 rotate-180" /> Back to {agent.name}
      </Link>
      <h1 className="relative z-10 mb-1 font-display text-2xl font-semibold">
        {managedAgent ? "Put funds under " : "Activate "}
        {agent.name}
      </h1>
      <p className="relative z-10 mb-8 max-w-xl text-sm text-muted">
        {managedAgent
          ? "A passkey-secured account, a USDT or USDC deposit, and one grant that lets the agent rotate your funds between lending venues, never anywhere else."
          : "Three steps: a passkey-secured account, a one-time gas top-up, and one signature granting exactly the authority you choose."}
      </p>
      {managedAgent ? (
        <ManagedWizard
          agent={{
            chainId: agent.chainId,
            tokenId: agent.tokenId,
            name: agent.name,
            managedAgent,
          }}
        />
      ) : (
        <SessionWizard
          agent={{
            chainId: agent.chainId,
            tokenId: agent.tokenId,
            name: agent.name,
            agentWallet: agent.agentWallet,
          }}
        />
      )}
    </div>
  );
}
