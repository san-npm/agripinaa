'use client';

import { useEffect, useState } from 'react';

import { SessionCard } from '@/components/SessionCard';
import { listStoredSessions, type StoredSessionMeta } from '@/lib/session-store';

export default function DashboardPage() {
  const [sessions, setSessions] = useState<StoredSessionMeta[] | null>(null);

  const refresh = () => setSessions(listStoredSessions());
  useEffect(refresh, []);

  return (
    <div className="max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold">My sessions</h1>
      <p className="mb-6 text-sm text-muted">
        Every key you have granted, with its live on-chain status read straight
        from the KeyStore registry. Revoking takes one passkey confirmation.
      </p>
      {sessions == null ? (
        <p className="text-muted-2">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong p-6 text-sm text-muted-2">
          No sessions yet. Pick an agent from a category and activate it; the
          granted session appears here.
        </p>
      ) : (
        <ul className="space-y-3">
          {sessions.map((meta) => (
            <SessionCard key={meta.id} meta={meta} onChange={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}
