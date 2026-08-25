import { agentByTokenId } from "@agripinaa/shared/agents";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ClaimForm } from "@/components/ClaimForm";
import { ArrowIcon } from "@/components/icons";
import { getClaim, liveClaimChain } from "@/lib/claims";
import { CHAIN_ID, getAgent } from "@/lib/data";

/**
 * Where an indexed agent's on-chain owner says what their agent does.
 *
 * Open to every third-party registration, claimed or not: an owner who wants to
 * correct a description signs a second claim and it replaces the first. Closed
 * to Agripinaa's own agents, which this repo already describes and whose keys
 * it holds, so a claim form on one of those pages would be theatre.
 *
 * The owner and the contract-wallet check are read here rather than in the
 * browser. The page has an RPC connection already, the form gets to render the
 * contract-wallet notice before anyone connects a wallet, and it keeps a page
 * view from spending an RPC call per visitor. None of it is trusted by the
 * server: POST /api/claim reads `ownerOf` itself before it stores anything.
 */
export default function ClaimPage(
  props: PageProps<"/agent/[chainId]/[tokenId]/claim">,
) {
  return (
    <Suspense fallback={<p className="text-muted-2">Loading…</p>}>
      <ClaimContent params={props.params} />
    </Suspense>
  );
}

async function ClaimContent({
  params,
}: {
  params: PageProps<"/agent/[chainId]/[tokenId]/claim">["params"];
}) {
  const { chainId, tokenId } = await params;
  if (Number.parseInt(chainId, 10) !== CHAIN_ID) notFound();

  const agent = await getAgent(tokenId);
  if (!agent) notFound();
  if (agentByTokenId(agent.tokenId)) notFound();

  // A node that did not answer has told us nothing about the token, so the
  // indexer's owner stands in and the form says where the address came from.
  const ownerRead = await liveClaimChain.ownerOf(agent.tokenId);
  const chainOwner = ownerRead.ok ? ownerRead.value : null;
  const codeRead = chainOwner ? await liveClaimChain.hasBytecode(chainOwner) : null;
  const existing = await getClaim(CHAIN_ID, agent.tokenId, {
    currentOwner: chainOwner,
  }).catch(() => null);

  return (
    <div className="max-w-2xl">
      <Link
        href={`/agent/${agent.chainId}/${agent.tokenId}`}
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted-2 transition-colors hover:text-foreground"
      >
        <ArrowIcon className="h-3.5 w-3.5 rotate-180" /> Back to {agent.name}
      </Link>
      <h1 className="mb-1 font-display text-2xl font-semibold">Claim {agent.name}</h1>
      <p className="mb-8 text-sm leading-relaxed text-muted">
        An ERC-8004 registration carries an id, an owner, and little else. Sign one message
        with the wallet that owns agent {agent.tokenId} and this listing carries your
        description, category, website, and endpoint instead of a blank.
      </p>

      <ClaimForm
        chainId={CHAIN_ID}
        tokenId={agent.tokenId}
        agentName={agent.name}
        owner={chainOwner ?? agent.owner}
        ownerFromChain={chainOwner !== null}
        ownerIsContract={codeRead?.ok === true && codeRead.value}
        existing={
          existing
            ? {
                description: existing.fields.description,
                category: existing.fields.category,
                website: existing.fields.website,
                endpoint: existing.fields.endpoint,
              }
            : null
        }
      />
    </div>
  );
}
