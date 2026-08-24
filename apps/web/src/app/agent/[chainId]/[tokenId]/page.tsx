import { bscScanAddress } from "@agripinaa/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ExecutionQualityPanel } from "@/components/ExecutionQualityPanel";
import { FreshnessStamp } from "@/components/FreshnessStamp";
import { ProofPanel } from "@/components/ProofPanel";
import { ArrowIcon, CATEGORY_ICON, TokenLogo, VerifiedIcon } from "@/components/icons";
import {
  ACTIVATION_BLOCKED_COPY,
  endpointIsLive,
  isActivatable,
} from "@/lib/activatable";
import { mergeAttestation, trustProvenanceLabel } from "@/lib/attestation-merge";
import { CATEGORY_INFO } from "@/lib/categories";
import { CHAIN_ID, getAgent, getFeedback } from "@/lib/data";
import { getOnchainAttestation } from "@/lib/onchain-rep";
import { clampDescription } from "@/lib/site";
import { VERIFIED_AGENTS } from "@/lib/verified";

/**
 * Every profile shipped under the one root title, so a shared link and a
 * search result named the site instead of the agent. `getAgent` is the same
 * `use cache` helper the page body calls, so this costs no extra fetch.
 */
export async function generateMetadata(
  props: PageProps<"/agent/[chainId]/[tokenId]">,
): Promise<Metadata> {
  const { chainId, tokenId } = await props.params;
  if (Number.parseInt(chainId, 10) !== CHAIN_ID) {
    return { title: "Agent not found · Agripinaa" };
  }
  const agent = await getAgent(tokenId).catch(() => null);
  if (!agent) return { title: "Agent not found · Agripinaa" };
  const title = `${agent.name} · Agripinaa`;
  const description = clampDescription(
    agent.description ||
      `ERC-8004 agent ${tokenId} on BNB Smart Chain, with its on-chain identity, reputation, and execution record.`,
  );
  return {
    title,
    description,
    openGraph: { title, description, type: "profile" },
    twitter: { title, description },
  };
}

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-border bg-surface p-5 ${className}`}>
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Addr({ chainId, address }: { chainId: number; address: string }) {
  return (
    <a
      href={bscScanAddress(chainId, address)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-muted transition-colors hover:text-foreground"
    >
      {address.slice(0, 10)}…{address.slice(-8)}
    </a>
  );
}

async function FeedbackList({ tokenId }: { tokenId: string }) {
  const feedback = await getFeedback(tokenId);
  const visible = feedback.filter((f) => !f.revoked).slice(0, 8);
  if (visible.length === 0) {
    return <p className="text-sm text-muted-2">No on-chain feedback yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {visible.map((f, i) => (
        <li
          key={f.txHash ?? i}
          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 p-3 text-sm"
        >
          <span className="font-mono text-xs text-muted-2">
            {f.client.slice(0, 10)}…
          </span>
          {f.tags.length > 0 && (
            <span className="truncate text-xs text-muted">{f.tags.join(" · ")}</span>
          )}
          {f.score != null && (
            <span className="tabular font-mono text-foreground">{f.score}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function AgentPage(props: PageProps<"/agent/[chainId]/[tokenId]">) {
  return (
    <Suspense fallback={<p className="text-muted-2">Loading agent…</p>}>
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
  const Icon = agent.category ? CATEGORY_ICON[agent.category] : null;
  const verified = VERIFIED_AGENTS[agent.tokenId];
  const attestation = verified ? await getOnchainAttestation(agent.tokenId) : null;
  // One merge rule for every surface that renders a score, so this page and a
  // hub card cannot disagree about the same agent, and the stamp below names
  // where each number actually came from.
  const trust = mergeAttestation(agent, attestation).trust;
  const activatable = isActivatable({
    tokenId: agent.tokenId,
    endpointLive: await endpointIsLive(agent),
  });

  return (
    <div className="max-w-4xl">
      <Link
        href="/agents"
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted-2 transition-colors hover:text-foreground"
      >
        <ArrowIcon className="h-3.5 w-3.5 rotate-180" /> All agents
      </Link>

      <div className="flex flex-wrap items-start gap-4">
        <span
          className={`grid h-14 w-14 shrink-0 place-items-center rounded-xl border ${
            category
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border bg-surface-2 text-muted-2"
          }`}
        >
          {Icon ? <Icon className="h-7 w-7" /> : <span>·</span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold">{agent.name}</h1>
            {verified ? (
              <span className="flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-on-primary">
                <VerifiedIcon className="h-3.5 w-3.5" /> Verified by Agripinaa
              </span>
            ) : (
              <span className="rounded-full border border-border-strong bg-surface px-2.5 py-0.5 text-xs text-muted-2">
                Registry · unverified
              </span>
            )}
            {category && (
              <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-muted">
                {category.label}
              </span>
            )}
            {verified && category && (
              <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-muted">
                <span className="flex -space-x-1">
                  {category.tokens.map((t) => (
                    <TokenLogo key={t} symbol={t} className="h-4 w-4 rounded-full ring-2 ring-surface" />
                  ))}
                </span>
                {category.tokens.join(" · ")}
              </span>
            )}
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            {agent.description || "No description provided by this agent."}
          </p>
        </div>
        {activatable ? (
          <Link
            href={`/agent/${agent.chainId}/${agent.tokenId}/activate`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)]"
          >
            Activate agent <ArrowIcon className="h-4 w-4" />
          </Link>
        ) : (
          <a
            href={bscScanAddress(agent.chainId, agent.agentWallet ?? agent.owner)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary"
          >
            Inspect on-chain identity <ArrowIcon className="h-4 w-4" />
          </a>
        )}
      </div>

      {!activatable && (
        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-muted-2">
          {ACTIVATION_BLOCKED_COPY}
        </p>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Panel title="Identity">
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-2">Agent ID</dt>
              <dd className="truncate font-mono text-xs text-muted">{agent.agentId}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-2">Owner</dt>
              <dd><Addr chainId={agent.chainId} address={agent.owner} /></dd>
            </div>
            {agent.agentWallet && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-2">Agent wallet</dt>
                <dd><Addr chainId={agent.chainId} address={agent.agentWallet} /></dd>
              </div>
            )}
            {agent.supportedProtocols.length > 0 && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-2">Protocols</dt>
                <dd className="text-muted">{agent.supportedProtocols.join(", ")}</dd>
              </div>
            )}
          </dl>
        </Panel>

        <Panel title="Trust">
          <dl className="grid grid-cols-3 gap-2 text-center">
            <TrustStat
              label={attestation ? "Attested" : "Score"}
              value={
                trust.totalScore != null && Number.isFinite(trust.totalScore)
                  ? String(trust.totalScore)
                  : "n/a"
              }
              highlight={!!attestation}
            />
            <TrustStat label="Rank" value={trust.rank != null ? `#${trust.rank}` : "n/a"} />
            <TrustStat
              label="Attestations"
              value={String(trust.totalFeedbacks)}
              highlight={!!attestation}
            />
          </dl>
          <p className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-2">
            {attestation
              ? "Read live from the ERC-8004 ReputationRegistry on-chain. Validation registry (TEE/zkML) not deployed on BSC yet."
              : "Validation registry not yet deployed (ERC-8004 is draft). Trust here is reputation-based."}
          </p>
          <FreshnessStamp asOf={trust.asOf} source={trustProvenanceLabel(trust)} />
        </Panel>
      </div>

      {verified && (
        <div className="mt-4">
          <ProofPanel agent={verified} />
        </div>
      )}

      <div className="mt-4">
        <Suspense
          fallback={
            <Panel title="Execution quality">
              <p className="text-sm text-muted-2">Loading execution history…</p>
            </Panel>
          }
        >
          <ExecutionQualityPanel wallet={agent.agentWallet ?? agent.owner} />
        </Suspense>
      </div>

      {!verified && (
        <div className="mt-4">
          <Panel title="On-chain feedback">
            <Suspense fallback={<p className="text-sm text-muted-2">Loading…</p>}>
              <FeedbackList tokenId={agent.tokenId} />
            </Suspense>
          </Panel>
        </div>
      )}
    </div>
  );
}

function TrustStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border py-3 ${highlight ? "border-primary/30 bg-primary/5" : "border-border bg-surface-2"}`}
    >
      <div
        className={`tabular font-mono text-xl font-medium ${highlight ? "text-primary" : "text-foreground"}`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-2">
        {label}
      </div>
    </div>
  );
}
