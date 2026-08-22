'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { routerByAddress } from '@agripinaa/shared/contracts';

import { ManagedPositionCard } from '@/components/ManagedPositionCard';
import { SessionCard } from '@/components/SessionCard';
import { ArrowIcon, CoinsIcon, LightningIcon, ShieldIcon } from '@/components/icons';
import { listStoredSessions, type StoredSessionMeta } from '@/lib/session-store';

/** A managed-yield session is scoped to one of the deployed router addresses. */
function isManaged(meta: StoredSessionMeta): boolean {
  return meta.scope.allowlist.some((a) => routerByAddress(a) !== undefined);
}

export default function DashboardPage() {
  const [sessions, setSessions] = useState<StoredSessionMeta[] | null>(null);

  const refresh = () => setSessions(listStoredSessions());
  useEffect(refresh, []);

  const active = sessions?.filter((s) => !s.revokedAt).length ?? 0;

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-2xl font-semibold">My sessions</h1>
      <p className="mt-2 text-sm text-muted">
        Every key you have granted, with its live on-chain status read straight
        from the KeyStore registry. Revoking takes one passkey confirmation.
      </p>

      {sessions == null ? (
        <div className="mt-8 h-32 animate-pulse rounded-2xl border border-border bg-surface" />
      ) : sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <p className="mt-6 text-xs uppercase tracking-wide text-muted-2">
            {active} active · {sessions.length} total
          </p>
          <ul className="mt-3 space-y-3">
            {sessions.map((meta) =>
              isManaged(meta) ? (
                <ManagedPositionCard key={meta.id} meta={meta} onChange={refresh} />
              ) : (
                <SessionCard key={meta.id} meta={meta} onChange={refresh} />
              ),
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="relative mt-8 overflow-hidden rounded-2xl border border-border bg-surface p-8">
      <div
        aria-hidden
        className="agp-orb pointer-events-none absolute -right-10 -top-10 z-0 h-48 w-48 rounded-full opacity-70"
      />
      <div className="relative z-10">
        <span className="grid h-12 w-12 place-items-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
          <ShieldIcon className="h-6 w-6" />
        </span>
        <h2 className="mt-4 font-display text-lg font-semibold">No active sessions</h2>
        <p className="mt-1 max-w-md text-sm text-muted">
          When you hire an agent, the scoped key you grant shows up here with its
          live status, and you can revoke it any time.
        </p>
        <Link
          href="/agents"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)]"
        >
          Browse verified agents <ArrowIcon className="h-4 w-4" />
        </Link>

        <div className="mt-8 grid gap-4 border-t border-border pt-6 sm:grid-cols-3">
          <Point icon={<ShieldIcon className="h-5 w-5" />} title="Scoped">
            The agent can call only the contracts you allowlist.
          </Point>
          <Point icon={<CoinsIcon className="h-5 w-5" />} title="Capped">
            A hard daily stablecoin limit, enforced on-chain.
          </Point>
          <Point icon={<LightningIcon className="h-5 w-5" />} title="Revocable">
            Self-expires, and one passkey tap ends it early.
          </Point>
        </div>
      </div>
    </div>
  );
}

function Point({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface-2 text-primary">
        {icon}
      </span>
      <h3 className="mt-2.5 text-sm font-medium">{title}</h3>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-2">{children}</p>
    </div>
  );
}
