import Link from "next/link";
import { Suspense } from "react";

import { AgentCard } from "@/components/AgentCard";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { ArrowIcon, CATEGORY_ICON, ReceiptIcon, ShieldIcon, VerifiedIcon } from "@/components/icons";
import { ProofFeed } from "@/components/ProofFeed";
import { ProofFeedLive } from "@/components/ProofFeedLive";
import { CATEGORY_INFO, CATEGORY_ORDER } from "@/lib/categories";
import { getStats, listDirectory } from "@/lib/data";

async function StatsStrip() {
  // listDirectory is a `use cache` entry keyed on its arguments, so the call
  // VerifiedAgents makes below reuses this one rather than refetching.
  const [stats, dir] = await Promise.all([getStats(), listDirectory()]);
  const items = [
    {
      value:
        stats.totalAgents != null
          ? stats.totalAgents.toLocaleString()
          : "—",
      label: stats.chainScoped
        ? "ERC-8004 agents registered on BSC"
        : "ERC-8004 agents registered",
    },
    {
      value: String(dir.verified.length),
      label: "live Agripinaa agents on mainnet",
    },
    {
      value: String(dir.registry.length),
      label: "indexed agents you can browse",
    },
  ];
  return (
    <dl className="grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-surface">
      {items.map((it) => (
        <div key={it.label} className="px-4 py-4 sm:px-6">
          <dt className="tabular font-mono text-lg font-medium text-foreground sm:text-2xl">
            <AnimatedNumber value={it.value} />
          </dt>
          <dd className="mt-0.5 text-[11px] leading-tight text-muted-2 sm:text-xs">
            {it.label}
          </dd>
        </div>
      ))}
    </dl>
  );
}

async function VerifiedAgents() {
  const dir = await listDirectory();
  if (dir.verified.length === 0) return null;
  return (
    <section className="mt-14">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <VerifiedIcon className="h-4 w-4 text-primary" /> Verified by Agripinaa
        </h2>
        <Link
          href="/agents"
          className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          Browse all <ArrowIcon className="h-3.5 w-3.5" />
        </Link>
      </div>
      <p className="mb-4 text-sm text-muted-2">
        Agents we built, ran, and verified on-chain: every action links to
        BscScan, with an ERC-8004 attestation.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dir.verified.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <div>
      <section className="relative py-6 sm:py-10">
        <div aria-hidden className="agp-dotgrid pointer-events-none absolute -inset-x-4 -top-10 z-0 h-96" />
        <div
          aria-hidden
          className="agp-orb pointer-events-none absolute -top-16 right-0 z-0 h-64 w-64 rounded-full sm:h-96 sm:w-96"
        />
        <div
          aria-hidden
          className="agp-orb-2 pointer-events-none absolute -top-24 right-40 z-0 h-56 w-56 rounded-full sm:h-72 sm:w-72"
        />
        <span className="relative z-10 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted">
          <VerifiedIcon className="h-3.5 w-3.5 text-primary" />
          ERC-8004 · BNB Smart Chain
        </span>
        <h1 className="relative z-10 mt-5 max-w-3xl font-display text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          The front door for every{" "}
          <span className="agp-gradient-text">agent on BSC</span>
        </h1>
        <p className="relative z-10 mt-5 max-w-2xl text-base leading-relaxed text-muted">
          Browse AI agents registered on-chain, read their real track record,
          and put one to work with a scoped, revocable session. No custody, no
          blind trust: here, performance is provable.
        </p>
        <div className="mt-8">
          <Suspense
            fallback={<div className="h-20 rounded-xl border border-border bg-surface" />}
          >
            <StatsStrip />
          </Suspense>
        </div>
      </section>

      <section className="mt-4">
        <Suspense fallback={<ProofFeed compact />}>
          <ProofFeedLive compact />
        </Suspense>
      </section>

      <section className="mt-10">
        <h2 className="mb-4 font-display text-lg font-semibold">
          Browse by category
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {CATEGORY_ORDER.map((category) => {
            const info = CATEGORY_INFO[category];
            const Icon = CATEGORY_ICON[category];
            return (
              <Link
                key={category}
                href={`/c/${category}`}
                className="agp-reveal agp-sheen group flex items-center gap-4 rounded-xl border border-border bg-surface p-5 transition-all duration-200 hover:border-primary/40 hover:shadow-[0_10px_30px_-12px_rgba(245,158,11,0.25)]"
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary shadow-[inset_0_0_16px_rgba(245,158,11,0.1)] transition-transform group-hover:scale-105">
                  <Icon className="h-6 w-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium">
                    {info.label}
                    <ArrowIcon className="h-4 w-4 text-muted-2 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-2">
                    {info.blurb}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mt-10 grid gap-4 rounded-xl border border-border bg-surface p-6 sm:grid-cols-3">
        <TrustPoint
          icon={<VerifiedIcon className="h-4 w-4" />}
          title="On-chain identity"
          body="Every agent is an ERC-8004 registration you can verify on BscScan."
        />
        <TrustPoint
          icon={<ReceiptIcon className="h-4 w-4" />}
          title="Provable execution"
          body="Trades route through Ophis batch auctions; surplus and receipts are settlement data, not claims."
        />
        <TrustPoint
          icon={<ShieldIcon className="h-4 w-4" />}
          title="Scoped & revocable"
          body="Hiring grants a session key with an allowlist, spend cap, and expiry. Revoke any time."
        />
      </section>

      <Suspense fallback={null}>
        <VerifiedAgents />
      </Suspense>
    </div>
  );
}

function TrustPoint({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div>
      <span className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface-2 text-primary">
        {icon}
      </span>
      <h3 className="mt-3 text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-2">{body}</p>
    </div>
  );
}
