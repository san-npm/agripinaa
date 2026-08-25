'use client';

import type { AgentSlug } from '@agripinaa/shared/agents';
import { useState } from 'react';

import { listStoredSessions } from '@/lib/session-store';
import { decodeChallenge, networkLabel, previewPayload, type X402Ask } from '@/lib/x402-demo';

/**
 * How long the browser waits on the proxy. The route gives the runner 5 s and
 * answers 502 when that passes; this guard covers a stalled function so the
 * panel can never sit on a spinner that does not resolve.
 */
const CLIENT_TIMEOUT_MS = 7_000;

type Outcome =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** The runner's 402, decoded: what it asks for before it answers. */
  | { kind: 'challenge'; ask: X402Ask; storedSession: boolean }
  /** A 200, which only a paid request gets; shown as the runner returned it. */
  | { kind: 'paid'; payload: unknown }
  /** No answer from the runner within the timeout, or the proxy said so. */
  | { kind: 'offline' }
  | { kind: 'unexpected'; detail: string };

async function fetchStatus(slug: AgentSlug, tokenId: string): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(`/api/x402/${slug}/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'offline' };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 402) {
    const ask = decodeChallenge(body);
    if (!ask) return { kind: 'unexpected', detail: 'The runner answered 402 with a challenge this page could not read.' };
    // Read only: which sessions exist is the one thing this panel learns from
    // storage, and it is never written back or sent anywhere.
    const storedSession = listStoredSessions().some(
      (session) => session.agent.tokenId === tokenId && session.revokedAt === null,
    );
    return { kind: 'challenge', ask, storedSession };
  }
  if (res.ok) return { kind: 'paid', payload: body };
  if (res.status === 502) return { kind: 'offline' };
  return { kind: 'unexpected', detail: `The runner answered ${res.status}.` };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-muted-2">{label}</dt>
      <dd className="min-w-0 break-all text-right font-mono text-xs text-muted">{children}</dd>
    </div>
  );
}

function Challenge({ ask, storedSession }: { ask: X402Ask; storedSession: boolean }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-primary">
        402: what the endpoint asks for
      </p>
      {ask.description && <p className="mt-1 text-sm text-muted">{ask.description}</p>}
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Amount">{ask.amountFormatted}</Row>
        <Row label="Asset">{ask.asset}</Row>
        <Row label="Pays to">{ask.payTo}</Row>
        <Row label="Network">{networkLabel(ask)}</Row>
        {ask.rail && <Row label="Rail">{ask.rail}</Row>}
        {ask.spender && <Row label="Permit2 spender">{ask.spender}</Row>}
        {ask.timeoutSeconds !== null && <Row label="Valid for">{ask.timeoutSeconds} s</Row>}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted-2">
        {storedSession
          ? 'A session for this agent is stored in this browser, but only its public half: the signer is stripped before storage on purpose, so this page cannot sign the payment.'
          : 'No session for this agent is stored in this browser, and a stored one keeps only its public half anyway, so this page cannot sign the payment.'}{' '}
        Paying needs an Altana session with its signer in hand (the activation flow grants
        one) or a wallet holding USDT with a Permit2 approval; what such a client signs is
        exactly the ask above, and the same request retried with the payment header returns
        the status.
      </p>
    </div>
  );
}

/**
 * The x402 status endpoint, made usable from the agent page: where it is, what
 * it costs, what comes back, and a button that asks the runner itself. The
 * endpoint arrives as a prop resolved on the server from the runner base, so
 * this component never decides where the runner is.
 */
export function X402Demo({
  slug,
  tokenId,
  endpoint,
  priceUsdt,
}: {
  slug: AgentSlug;
  tokenId: string;
  /** Resolved server-side from runnerUrl(); shown and never fetched directly. */
  endpoint: string;
  priceUsdt: string;
}) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const busy = outcome.kind === 'loading';

  async function run() {
    setOutcome({ kind: 'loading' });
    setOutcome(await fetchStatus(slug, tokenId));
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-2">
        x402 status endpoint
      </h2>
      <p className="text-sm leading-relaxed text-muted">
        Reading this agent&apos;s live status is one paid HTTP call on the B402 wire
        (Binance x402 v2) over BNB Smart Chain: the endpoint answers 402 with its
        payment requirements, the client signs a USDT transfer to the agent&apos;s own
        wallet, and the same request retried with the payment header returns the
        status.
      </p>
      <dl className="mt-4 space-y-2 text-sm">
        <Row label="Endpoint">
          <a
            href={endpoint}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-border-strong underline-offset-2 transition-colors hover:text-primary"
          >
            {endpoint}
          </a>
        </Row>
        <Row label="Price">{priceUsdt} USDT per call</Row>
        <Row label="Pays to">the agent&apos;s own wallet</Row>
      </dl>

      <p className="mt-4 text-xs text-muted-2">
        Example response after payment. The shape is what the runner returns; the values
        are illustrative.
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-muted">
        {JSON.stringify(previewPayload(slug), null, 2)}
      </pre>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-[var(--primary-050)] disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Asking the runner…' : outcome.kind === 'idle' ? 'Fetch live status' : 'Fetch again'}
        </button>
        {outcome.kind === 'idle' && (
          <span className="text-xs text-muted-2">Unpaid, so the runner answers with its 402 challenge.</span>
        )}
      </div>

      <div className="mt-4" aria-live="polite">
        {outcome.kind === 'challenge' && (
          <Challenge ask={outcome.ask} storedSession={outcome.storedSession} />
        )}
        {outcome.kind === 'paid' && (
          <pre className="overflow-x-auto rounded-lg border border-success/25 bg-success/5 p-3 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(outcome.payload, null, 2)}
          </pre>
        )}
        {outcome.kind === 'offline' && (
          <div className="rounded-lg border border-border bg-surface-2 p-4">
            <p className="text-sm font-medium text-foreground">Runner offline</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-2">
              The status endpoint did not answer within 5 seconds. On-chain data on this
              page is still live; the endpoint comes back with the tunnel.
            </p>
          </div>
        )}
        {outcome.kind === 'unexpected' && (
          <p className="text-xs leading-relaxed text-muted-2">{outcome.detail}</p>
        )}
      </div>
    </section>
  );
}
