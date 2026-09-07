import type { AgentSummary } from "@agripinaa/agent-index";
import { agentByTokenId } from "@agripinaa/shared/agents";
import Link from "next/link";

import { agentExperience } from "@/lib/agent-experience";
import { CATEGORY_INFO } from "@/lib/categories";
import { claimProvenanceLabel } from "@/lib/claim-merge";
import { isVerified } from "@/lib/verified";
import { EndpointLiveBadge } from "./EndpointLive";
import { AgentArtwork } from "./AgentArtwork";
import { AgentProtocols } from "./ProtocolLogo";
import { CATEGORY_ICON, VerifiedIcon } from "./icons";

export function AgentCard({ agent }: { agent: AgentSummary }) {
  const cat = agent.category ? CATEGORY_INFO[agent.category] : null;
  const Icon = agent.category ? CATEGORY_ICON[agent.category] : null;
  const verified = isVerified(agent.tokenId);
  const registryRecord = agentByTokenId(agent.tokenId);
  const experience = registryRecord ? agentExperience(registryRecord.slug) : null;
  // Names the fields this agent's owner filled in, so owner-written text is
  // never mistaken for indexed metadata. Unrelated to the verified treatment:
  // a claim says who wrote the copy, not that anyone vouches for the agent.
  const ownerProvided = claimProvenanceLabel(agent);
  // Set upstream from the stored probe result, so a card never fetches anything
  // itself and an endpoint nobody re-probed inside the window loses the badge.
  const endpointLive = agent.endpointLive === true;
  return (
    <Link
      href={`/agent/${agent.chainId}/${agent.tokenId}`}
      className="agent-card group min-w-0"
      data-agent={registryRecord?.slug}
    >
      {registryRecord && <div className="card-visual agent-visual" data-agent={registryRecord.slug}>
        <span className="art-label">{experience?.directoryLabel}</span>
        <AgentArtwork slug={registryRecord.slug} tokens />
      </div>}
      <div className="mb-4 min-h-5 text-xs text-primary">
        {verified && <span className="flex items-center gap-1.5"><VerifiedIcon className="h-3.5 w-3.5" /> Verified by Agripinaa</span>}
      </div>
      <div className="flex items-start gap-3">
        {!registryRecord && <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${
            cat
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border bg-surface-2 text-muted-2"
          }`}
        >
          {Icon ? <Icon className="h-[18px] w-[18px]" /> : <span className="text-xs">·</span>}
        </span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 title={agent.name} className="min-w-0 truncate font-medium leading-tight text-foreground">
              {agent.name}
            </h3>
            {agent.trust.isVerified && (
              <VerifiedIcon className="h-4 w-4 shrink-0 text-primary" />
            )}
          </div>
          {!experience && <p className="mt-0.5 truncate text-xs text-muted-2">
            {cat
              ? cat.label
              : agent.duplicateCount && agent.duplicateCount > 1
                ? `${agent.duplicateCount} registrations, same name`
                : "Unclassified"}
          </p>}
        </div>
      </div>

      <p className="mt-4 line-clamp-3 min-h-[3.75rem] text-sm leading-relaxed text-muted">
        {experience?.summary || agent.description || "No description provided by this agent."}
      </p>

      {ownerProvided && (
        <p className="mt-1.5 font-mono text-xs text-muted-2">{ownerProvided}</p>
      )}

      {registryRecord && <AgentProtocols slug={registryRecord.slug} />}
      <div className="mt-5 flex items-center gap-4 border-t border-border pt-4 text-xs">
        <Stat label="Score" value={agent.trust.totalScore != null ? String(agent.trust.totalScore) : "n/a"} />
        <Stat label="Feedback" value={String(agent.trust.totalFeedbacks)} />
        {(endpointLive || agent.x402Supported) && (
          <span className="ml-auto flex items-center gap-1.5">
            {endpointLive && <EndpointLiveBadge />}
            {agent.x402Supported && (
              <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent">
                x402
              </span>
            )}
          </span>
        )}
      </div>
      <div className="mt-auto pt-4">
        <div className="card-action"><span>View strategy</span><span aria-hidden>↗</span></div>
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-xs text-muted-2">{label}</span>
      <span className="tabular font-mono text-foreground">{value}</span>
    </span>
  );
}
