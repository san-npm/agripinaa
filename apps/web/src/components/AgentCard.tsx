import type { AgentSummary } from "@agripinaa/agent-index";
import Link from "next/link";

import { CATEGORY_INFO } from "@/lib/categories";
import { isVerified } from "@/lib/verified";
import { CATEGORY_ICON, TokenLogo, VerifiedIcon } from "./icons";

export function AgentCard({ agent }: { agent: AgentSummary }) {
  const cat = agent.category ? CATEGORY_INFO[agent.category] : null;
  const Icon = agent.category ? CATEGORY_ICON[agent.category] : null;
  const verified = isVerified(agent.tokenId);
  // Tokens this agent works with (only known for our verified agents).
  const tokens = verified && cat ? cat.tokens : null;

  return (
    <Link
      href={`/agent/${agent.chainId}/${agent.tokenId}`}
      className={`agp-reveal agp-sheen group relative flex flex-col rounded-xl border p-4 transition-all duration-200 focus-visible:border-primary ${
        verified
          ? "border-primary/30 bg-[linear-gradient(180deg,rgba(245,158,11,0.05),transparent_55%)] hover:border-primary/50 hover:shadow-[0_10px_30px_-12px_rgba(245,158,11,0.3)]"
          : "border-border bg-surface hover:border-border-strong hover:bg-surface-2"
      }`}
    >
      {verified && (
        <span className="absolute -top-px right-4 flex items-center gap-1 rounded-b-md bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-primary">
          <VerifiedIcon className="h-3 w-3" /> Verified
        </span>
      )}
      <div className="flex items-start gap-3">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${
            cat
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border bg-surface-2 text-muted-2"
          }`}
        >
          {Icon ? <Icon className="h-[18px] w-[18px]" /> : <span className="text-xs">·</span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate font-medium leading-tight text-foreground">
              {agent.name}
            </h3>
            {agent.trust.isVerified && (
              <VerifiedIcon className="h-4 w-4 shrink-0 text-primary" />
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-2">
            {cat
              ? cat.label
              : agent.duplicateCount && agent.duplicateCount > 1
                ? `${agent.duplicateCount} registrations, same name`
                : "Unclassified"}
          </p>
        </div>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-muted">
        {agent.description || "No description provided by this agent."}
      </p>

      {tokens && (
        <div className="mt-3 flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {tokens.map((t) => (
              <TokenLogo key={t} symbol={t} className="h-5 w-5 rounded-full ring-2 ring-surface" />
            ))}
          </span>
          <span className="text-xs font-medium text-muted">{tokens.join(" · ")}</span>
        </div>
      )}

      <div className="mt-3 flex items-center gap-4 border-t border-border pt-3 text-xs">
        <Stat label="Score" value={agent.trust.totalScore != null ? String(agent.trust.totalScore) : "—"} />
        <Stat label="Feedback" value={String(agent.trust.totalFeedbacks)} />
        {agent.x402Supported && (
          <span className="ml-auto rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            x402
          </span>
        )}
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-2">{label}</span>
      <span className="tabular font-mono text-foreground">{value}</span>
    </span>
  );
}
