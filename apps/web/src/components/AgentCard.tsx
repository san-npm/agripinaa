import type { AgentSummary } from "@agripinaa/agent-index";
import Link from "next/link";

import { FreshnessStamp } from "./FreshnessStamp";

export function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <Link
      href={`/agent/${agent.chainId}/${agent.tokenId}`}
      className="block rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition hover:border-zinc-600"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium leading-tight">{agent.name}</h3>
        {agent.trust.isVerified && (
          <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
            verified
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-zinc-400">
        {agent.description || "No description provided."}
      </p>
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <div>
          <dt className="inline">Score: </dt>
          <dd className="inline text-zinc-300">
            {agent.trust.totalScore ?? "n/a"}
          </dd>
        </div>
        <div>
          <dt className="inline">Feedback: </dt>
          <dd className="inline text-zinc-300">{agent.trust.totalFeedbacks}</dd>
        </div>
        {agent.x402Supported && (
          <div className="text-amber-300/80">x402</div>
        )}
      </dl>
      <FreshnessStamp asOf={agent.trust.asOf} source={agent.trust.source} />
    </Link>
  );
}
