import { bscScanAddress } from "@agripinaa/shared";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ExecutionQualityPanel } from "@/components/ExecutionQualityPanel";
import { FreshnessStamp } from "@/components/FreshnessStamp";
import { CATEGORY_INFO } from "@/lib/categories";
import { CHAIN_ID, getAgent, getFeedback } from "@/lib/data";

async function FeedbackList({ tokenId }: { tokenId: string }) {
  const feedback = await getFeedback(tokenId);
  const visible = feedback.filter((f) => !f.revoked).slice(0, 10);
  if (visible.length === 0) {
    return <p className="text-sm text-zinc-500">No on-chain feedback yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {visible.map((f, i) => (
        <li
          key={f.txHash ?? i}
          className="rounded border border-zinc-800 p-3 text-sm"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-zinc-500">
              {f.client.slice(0, 10)}…
            </span>
            {f.score != null && (
              <span className="text-zinc-300">score {f.score}</span>
            )}
          </div>
          {f.tags.length > 0 && (
            <p className="mt-1 text-xs text-zinc-500">{f.tags.join(" · ")}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function AgentPage(props: PageProps<"/agent/[chainId]/[tokenId]">) {
  return (
    <Suspense fallback={<p className="text-zinc-500">Loading agent…</p>}>
      <AgentContent params={props.params} />
    </Suspense>
  );
}

async function AgentContent({
  params,
}: {
  params: PageProps<"/agent/[chainId]/[tokenId]">["params"];
}) {
  const { chainId, tokenId } = await params;
  if (Number.parseInt(chainId, 10) !== CHAIN_ID) notFound();

  const agent = await getAgent(tokenId);
  if (!agent) notFound();

  const category = agent.category ? CATEGORY_INFO[agent.category] : null;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{agent.name}</h1>
        {category && (
          <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300">
            {category.label}
          </span>
        )}
        {agent.trust.isVerified && (
          <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-300">
            verified
          </span>
        )}
      </div>
      <p className="mt-3 text-zinc-400">
        {agent.description || "No description provided."}
      </p>

      <section className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 p-4">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Identity
          </h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-zinc-500">Agent ID</dt>
              <dd className="break-all font-mono text-xs text-zinc-300">
                {agent.agentId}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Owner</dt>
              <dd className="font-mono text-xs">
                <a
                  href={bscScanAddress(agent.chainId, agent.owner)}
                  className="text-zinc-300 underline hover:text-white"
                >
                  {agent.owner}
                </a>
              </dd>
            </div>
            {agent.agentWallet && (
              <div>
                <dt className="text-zinc-500">Agent wallet</dt>
                <dd className="font-mono text-xs">
                  <a
                    href={bscScanAddress(agent.chainId, agent.agentWallet)}
                    className="text-zinc-300 underline hover:text-white"
                  >
                    {agent.agentWallet}
                  </a>
                </dd>
              </div>
            )}
            {agent.supportedProtocols.length > 0 && (
              <div>
                <dt className="text-zinc-500">Protocols</dt>
                <dd className="text-zinc-300">
                  {agent.supportedProtocols.join(", ")}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="rounded-lg border border-zinc-800 p-4">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Trust
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Total score</dt>
              <dd className="text-zinc-200">{agent.trust.totalScore ?? "n/a"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Rank</dt>
              <dd className="text-zinc-200">{agent.trust.rank ?? "n/a"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Feedback entries</dt>
              <dd className="text-zinc-200">{agent.trust.totalFeedbacks}</dd>
            </div>
          </dl>
          <p className="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-600">
            Validation registry: not yet deployed (ERC-8004 is a draft
            standard). Trust here is reputation-based.
          </p>
          <FreshnessStamp asOf={agent.trust.asOf} source={agent.trust.source} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          On-chain feedback
        </h2>
        <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
          <FeedbackList tokenId={agent.tokenId} />
        </Suspense>
      </section>

      <div className="mt-8">
        <Suspense
          fallback={
            <p className="text-sm text-zinc-500">Loading execution history…</p>
          }
        >
          <ExecutionQualityPanel wallet={agent.agentWallet ?? agent.owner} />
        </Suspense>
      </div>
    </div>
  );
}
