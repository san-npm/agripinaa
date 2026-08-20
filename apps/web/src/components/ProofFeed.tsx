'use client';

import type { ProofEvent, ProofFeedPayload, ProofKind } from '@agripinaa/shared';
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';

import { ArrowIcon, CATEGORY_ICON } from './icons';

const KIND_LABEL: Record<ProofKind, string> = {
  trade: 'surplus',
  repair: 'repair',
  rotate: 'rotation',
  rebalance: 'range',
  mint: 'mint',
};

const KIND_CLASS: Record<ProofKind, string> = {
  trade: 'border-success/25 bg-success/10 text-success',
  repair: 'border-primary/25 bg-primary/10 text-primary',
  rotate: 'border-accent/25 bg-accent/10 text-accent',
  rebalance: 'border-accent/25 bg-accent/10 text-accent',
  mint: 'border-primary/25 bg-primary/10 text-primary',
};

function relativeTime(at: string): string {
  const seconds = Math.round((Date.parse(at) - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (absolute < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function ProofRow({ event, index }: { event: ProofEvent; index: number }) {
  const Icon = CATEGORY_ICON[event.category];
  const bps = event.surplusBps;
  return (
    <li
      className="agp-proof-event group flex gap-3 border-b border-border px-4 py-4 last:border-b-0 sm:px-5"
      style={{ '--agp-delay': `${Math.min(index, 8) * 35}ms` } as CSSProperties}
    >
      <Link
        href={`/agent/56/${event.agent}`}
        aria-label={`Open ${event.agentName}`}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-primary/25 bg-gradient-to-br from-primary/15 to-accent/10 text-primary transition-colors group-hover:border-primary/40"
      >
        <Icon className="h-[18px] w-[18px]" />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/agent/56/${event.agent}`}
            className="text-xs font-medium text-foreground transition-colors hover:text-primary"
          >
            {event.agentName}
          </Link>
          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${KIND_CLASS[event.kind]}`}>
            {bps !== undefined ? `${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps` : KIND_LABEL[event.kind]}
          </span>
          <time
            dateTime={event.at}
            title={new Date(event.at).toLocaleString()}
            className="ml-auto text-[10px] text-muted-2"
          >
            {relativeTime(event.at)}
          </time>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted">{event.summary}</p>
        {(event.txHash || event.orderUid) && (
          <div className="mt-1.5 flex items-center gap-3 font-mono text-[10px]">
            {event.txHash && (
              <a
                href={`https://bscscan.com/tx/${event.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-muted-2 underline decoration-border-strong underline-offset-2 transition-colors hover:text-primary"
              >
                settlement tx ↗
              </a>
            )}
            {event.orderUid && (
              <a
                href={`https://explorer.ophis.fi/orders/${event.orderUid}`}
                target="_blank"
                rel="noreferrer"
                className="text-muted-2 underline decoration-border-strong underline-offset-2 transition-colors hover:text-primary"
              >
                Ophis receipt ↗
              </a>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function ProofFeed({ compact = false }: { compact?: boolean }) {
  const [payload, setPayload] = useState<ProofFeedPayload | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      active?.abort();
      active = new AbortController();
      try {
        const response = await fetch('/api/proof', {
          cache: 'no-store',
          signal: active.signal,
        });
        if (!response.ok) throw new Error(`proof feed ${response.status}`);
        const next = await response.json() as ProofFeedPayload;
        if (!disposed && Array.isArray(next.events)) {
          setPayload(next);
          setError(false);
        }
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(true);
        }
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      active?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const events = payload?.events.slice(0, compact ? 5 : 40) ?? [];
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5 sm:px-5">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
        <h2 className="font-display text-sm font-semibold">Live activity</h2>
        <span className="text-[10px] text-muted-2">
          {error ? 'reconnecting…' : payload ? 'verified on BNB Chain' : 'connecting…'}
        </span>
        {compact && (
          <Link
            href="/proof"
            className="ml-auto flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            View all <ArrowIcon className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      {payload === null ? (
        <div className="space-y-3 p-4" aria-label="Loading proof feed" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex animate-pulse gap-3">
              <span className="h-9 w-9 rounded-lg bg-surface-2" />
              <span className="flex-1 space-y-2 py-1">
                <span className="block h-2 w-1/3 rounded bg-surface-2" />
                <span className="block h-3 w-4/5 rounded bg-surface-2" />
              </span>
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-muted">Proof feed is warming up.</p>
          <p className="mt-1 text-xs text-muted-2">The next verified agent action will appear here automatically.</p>
        </div>
      ) : (
        <ol aria-live="polite" className="divide-y-0">
          {events.map((event, index) => (
            <ProofRow key={event.id} event={event} index={index} />
          ))}
        </ol>
      )}

      {!compact && payload && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-2/50 px-5 py-3 text-[10px] text-muted-2">
          <span>{events.length} actions · refreshes every 15 seconds</span>
          <span>Runner log + Ophis settlement backfill</span>
        </div>
      )}
    </section>
  );
}
