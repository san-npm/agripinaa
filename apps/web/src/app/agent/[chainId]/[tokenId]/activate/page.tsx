import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SessionWizard } from "@/components/SessionWizard";
import { CHAIN_ID, getAgent } from "@/lib/data";

export default function ActivatePage(
  props: PageProps<"/agent/[chainId]/[tokenId]/activate">,
) {
  return (
    <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
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

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Activate {agent.name}</h1>
      <p className="mb-8 max-w-xl text-sm text-zinc-400">
        Three steps: a passkey-secured account, a one-time gas top-up, and one
        signature granting exactly the authority you choose.
      </p>
      <SessionWizard
        agent={{
          chainId: agent.chainId,
          tokenId: agent.tokenId,
          name: agent.name,
          agentWallet: agent.agentWallet,
        }}
      />
    </div>
  );
}
