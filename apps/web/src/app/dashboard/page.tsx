'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { AGENTS, agentBySlug, type AgentRecord } from '@agripinaa/shared/agents';
import { recoveryRouterFromAllowlist } from '@agripinaa/shared/contracts';
import { managedStrategyFor } from '@agripinaa/shared/managed-strategies';

import { ManagedPositionCard } from '@/components/ManagedPositionCard';
import { SessionCard } from '@/components/SessionCard';
import { ArrowIcon, CoinsIcon, LightningIcon, ReceiptIcon, ShieldIcon } from '@/components/icons';
import {
  listFundingCheckpoints,
  type FundingCheckpoint,
} from '@/lib/funding-checkpoint';
import { fundingRecoveryHash } from '@/lib/funding-recovery';
import { listStoredSessions, type StoredSessionMeta } from '@/lib/session-store';

const RECOVERABLE_AGENTS = Object.values(AGENTS).flatMap((agent) =>
  agent.managed && agent.tokenId !== null && managedStrategyFor(agent.slug)
    ? [{ slug: agent.slug, name: agent.name, tokenId: agent.tokenId }]
    : []);

/** Active and recovery-only managed sessions both retain their funds controls. */
function isManaged(meta: StoredSessionMeta): boolean {
  return recoveryRouterFromAllowlist(meta.scope.allowlist, meta.chainId) !== undefined;
}

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<{
    sessions: StoredSessionMeta[];
    pending: PendingActivation[];
  } | null>(null);

  const refresh = useCallback(() => {
    const sessions = listStoredSessions();
    const pending = listFundingCheckpoints().flatMap((entry) => {
      const agent = agentBySlug(entry.agent);
      const matchingSessions = sessions.filter((session) =>
        session.chainId === entry.chainId
        && session.account.toLowerCase() === entry.account.toLowerCase()
        && session.agent.slug === entry.agent
        && session.revokedAt === null);
      const followsCheckpoint = (session: StoredSessionMeta) => {
        const savedAt = entry.checkpoint.savedAt;
        return savedAt === undefined || Date.parse(session.grantedAt) >= savedAt;
      };
      const completedSession = matchingSessions.find((session) =>
        session.registrationStatus === 'registered' && followsCheckpoint(session));
      const pendingSession = matchingSessions.find((session) =>
        session.registrationStatus === 'pending'
        && Date.parse(session.scope.expiresAt) > Date.now()
        && followsCheckpoint(session));
      if (
        entry.chainId !== 56
        || !agent?.managed
        || agent.tokenId === null
        || completedSession
      ) return [];
      return [{ ...entry, agent, session: pendingSession }];
    });
    setDashboard({ sessions, pending });
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-2xl font-semibold">My sessions</h1>
      <p className="mt-2 text-sm text-muted">
        Track unfinished activations and every key you have granted, with live
        on-chain status read straight from the KeyStore registry.
      </p>

      {dashboard !== null && <MissingActivationRecovery />}

      {dashboard == null ? (
        <div className="mt-8 h-32 animate-pulse rounded-2xl border border-border bg-surface" />
      ) : dashboard.sessions.length === 0 && dashboard.pending.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {dashboard.pending.length > 0 && (
            <section aria-labelledby="unfinished-activations" className="mt-8">
              <h2 id="unfinished-activations" className="text-xs uppercase tracking-wide text-muted-2">
                Finish activation
              </h2>
              <ul className="mt-3 space-y-3">
                {dashboard.pending.map((activation) => (
                  <PendingActivationCard
                    key={`${activation.chainId}:${activation.account}:${activation.agent.slug}`}
                    activation={activation}
                  />
                ))}
              </ul>
            </section>
          )}

          {dashboard.sessions.length > 0 ? (
            <section aria-labelledby="saved-sessions" className="mt-6">
              <h2 id="saved-sessions" className="text-xs uppercase tracking-wide text-muted-2">
                {dashboard.sessions.length} saved session{dashboard.sessions.length === 1 ? '' : 's'} · live status shown per card
              </h2>
              <ul className="mt-3 space-y-3">
                {dashboard.sessions.map((meta) =>
                  isManaged(meta) ? (
                    <ManagedPositionCard key={meta.id} meta={meta} onChange={refresh} />
                  ) : (
                    <SessionCard key={meta.id} meta={meta} onChange={refresh} />
                  ),
                )}
              </ul>
            </section>
          ) : (
            <p className="mt-5 text-sm text-muted">
              No session key has been granted yet. Finish the activation above to start the agent.
            </p>
          )}
        </>
      )}

    </div>
  );
}

interface PendingActivation {
  chainId: number;
  account: `0x${string}`;
  agent: AgentRecord;
  checkpoint: FundingCheckpoint;
  session?: StoredSessionMeta;
}

function PendingActivationCard({ activation }: { activation: PendingActivation }) {
  const { agent, account, checkpoint, chainId, session } = activation;
  const status = session
    ? 'Session saved · handoff unfinished'
    : checkpoint.status === 'confirmed'
      ? 'Funding confirmed'
      : 'Funding transaction saved';
  const shortAccount = `${account.slice(0, 6)}…${account.slice(-4)}`;

  return (
    <li className="relative overflow-hidden rounded-2xl border border-primary/35 bg-surface p-6">
      <div
        aria-hidden
        className="agp-orb pointer-events-none absolute -right-12 -top-14 h-40 w-40 rounded-full opacity-50"
      />
      <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <CoinsIcon className="h-5 w-5" />
            </span>
            <span role="status" className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {status}
            </span>
          </div>
          <h3 className="mt-3 font-display text-lg font-semibold">{agent.name}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {session ? (
              <>
                The scoped session is saved, but the agent handoff did not finish. Use the saved
                session below to complete it. <strong className="font-semibold text-foreground">Do not deposit or grant another key.</strong>
              </>
            ) : (
              <>
                The funding step is saved, but the agent has not received a session key yet.
                Recover account <span className="font-mono text-xs text-foreground">{shortAccount}</span>{' '}
                with the same passkey and finish activation. <strong className="font-semibold text-foreground">Do not deposit again.</strong>
              </>
            )}
          </p>
        </div>
        {session ? (
          <a
            href={`#session-${session.id}`}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.3)] transition-all hover:bg-[var(--primary-050)]"
          >
            Finish handoff <ArrowIcon className="h-4 w-4" />
          </a>
        ) : (
          <Link
            href={`/agent/${chainId}/${agent.tokenId}/activate`}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.3)] transition-all hover:bg-[var(--primary-050)]"
          >
            Resume {agent.name.replace(/^Agripinaa /, '')} <ArrowIcon className="h-4 w-4" />
          </Link>
        )}
      </div>
    </li>
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
            Published call limits and account isolation bound the authority you grant.
          </Point>
          <Point icon={<LightningIcon className="h-5 w-5" />} title="Revocable">
            Self-expires, and one passkey tap ends it early.
          </Point>
        </div>
      </div>
    </div>
  );
}

function MissingActivationRecovery() {
  const router = useRouter();
  const [tokenId, setTokenId] = useState('');
  const [transactionHash, setTransactionHash] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  return (
    <section aria-labelledby="missing-activation" className="mt-6 rounded-2xl border border-primary/30 bg-surface p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
          <ReceiptIcon className="h-5 w-5" />
        </span>
        <div>
          <h2 id="missing-activation" className="font-display text-lg font-semibold">
            Funded an agent but it does not appear?
          </h2>
          <p id="missing-activation-help" className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
            Recover the activation from its successful BNB Chain transaction. Agripinaa verifies
            the transaction against your passkey account before skipping the completed funding step.
          </p>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const hash = fundingRecoveryHash(transactionHash);
          if (!tokenId || !hash) {
            setRecoveryError('Choose the funded agent and enter its complete 0x transaction hash.');
            return;
          }
          setRecoveryError(null);
          router.push(`/agent/56/${tokenId}/activate?recoverTx=${encodeURIComponent(hash)}`);
        }}
        className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-end"
      >
        <label className="text-xs font-medium text-foreground">
          Agent
          <select
            value={tokenId}
            onChange={(event) => setTokenId(event.target.value)}
            aria-describedby="missing-activation-help"
            className="mt-1.5 min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">Choose an agent</option>
            {RECOVERABLE_AGENTS.map((agent) => (
              <option key={agent.slug} value={agent.tokenId}>{agent.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-foreground">
          Funding transaction hash
          <input
            value={transactionHash}
            onChange={(event) => setTransactionHash(event.target.value)}
            aria-describedby="missing-activation-help"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="0x…"
            className="mt-1.5 min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-muted-2 focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-lg border border-primary/45 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          Continue recovery
        </button>
      </form>
      {recoveryError && (
        <p role="alert" className="mt-3 text-sm text-danger">{recoveryError}</p>
      )}
    </section>
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
