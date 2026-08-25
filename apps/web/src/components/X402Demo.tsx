'use client';

import { AGENTS, type AgentSlug } from '@agripinaa/shared/agents';
import { useState } from 'react';

import { listStoredSessions } from '@/lib/session-store';
import { askStatusEndpoint, type StatusEndpointAnswer } from '@/lib/x402-status';
import {
  checkPayTo,
  networkLabel,
  previewPayload,
  readStatusAnswer,
  type PayToCheck,
  type X402Ask,
} from '@/lib/x402-demo';

/**
 * How long the browser waits on the server function. It gives the runner 5 s
 * and answers "unreachable" when that passes; this guard covers a stalled
 * function so the panel can never sit on a spinner that does not resolve.
 */
const CLIENT_TIMEOUT_MS = 7_000;

type Outcome =
  | { kind: 'idle' }
  /** In flight; `again` after a failed attempt, which is the proof feed's reconnecting state. */
  | { kind: 'loading'; again: boolean }
  /** The runner's 402, decoded, with its payTo judged against the registry. */
  | { kind: 'challenge'; ask: X402Ask; payTo: PayToCheck; storedSession: boolean }
  /** A 200, which only a paid request gets; shown as the runner returned it. */
  | { kind: 'paid'; payload: unknown }
  /** No answer from the runner within the timeout, or the server function said so. */
  | { kind: 'offline' }
  | { kind: 'unexpected'; detail: string };

/** The server function's answer after the client guard: `timeout` when it did not settle in time. */
function askWithGuard(slug: AgentSlug): Promise<StatusEndpointAnswer | { kind: 'timeout' }> {
  return Promise.race([
    askStatusEndpoint(slug),
    new Promise<{ kind: 'timeout' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'timeout' }), CLIENT_TIMEOUT_MS),
    ),
  ]);
}

async function fetchStatus(slug: AgentSlug, tokenId: string): Promise<Outcome> {
  let answer: StatusEndpointAnswer | { kind: 'timeout' };
  try {
    answer = await askWithGuard(slug);
  } catch {
    // A failed POST, or a stale action id after a redeploy; either way no answer.
    return { kind: 'offline' };
  }
  const verdict = readStatusAnswer(answer);
  if (verdict.kind !== 'challenge') return verdict;
  // Read only: which sessions exist is the one thing this panel learns from
  // storage, and it is never written back or sent anywhere.
  const storedSession = listStoredSessions().some(
    (session) => session.agent.tokenId === tokenId && session.revokedAt === null,
  );
  return {
    kind: 'challenge',
    ask: verdict.ask,
    payTo: checkPayTo(slug, verdict.ask.payTo),
    storedSession,
  };
}

/** The status tag beside the heading, in the proof feed's wording. */
function statusTag(outcome: Outcome): string | null {
  switch (outcome.kind) {
    case 'idle':
      return null;
    case 'loading':
      return outcome.again ? 'reconnecting…' : 'connecting…';
    case 'offline':
      return 'runner offline';
    default:
      return 'runner live';
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-muted-2">{label}</dt>
      <dd className="min-w-0 break-all text-right font-mono text-xs text-muted">{children}</dd>
    </div>
  );
}

/**
 * The destination is shown as somewhere to pay only when it is the wallet the
 * registry commits for this agent; otherwise the panel refuses the challenge
 * and says why, and the how-to-pay text below is not rendered at all.
 */
function PayToRefused({ payTo }: { payTo: Exclude<PayToCheck, { verdict: 'pinned' }> }) {
  return (
    <div className="mt-3 rounded-lg border border-danger/40 bg-danger/5 p-3 text-xs leading-relaxed text-muted">
      <p className="font-medium text-foreground">Do not pay this challenge.</p>
      {payTo.verdict === 'mismatch' ? (
        <p className="mt-1">
          It names <span className="break-all font-mono">{payTo.reported}</span> as the
          destination, and the registry wallet for this agent is{' '}
          <span className="break-all font-mono">{payTo.expected}</span>. The runner base is a
          rotating tunnel hostname, so an answer that pays anywhere else is treated as not
          coming from this agent.
        </p>
      ) : (
        <p className="mt-1">
          The registry holds no wallet for this agent yet, so nothing can vouch for{' '}
          <span className="break-all font-mono">{payTo.reported}</span> as the destination.
        </p>
      )}
    </div>
  );
}

function Challenge({
  ask,
  payTo,
  storedSession,
}: {
  ask: X402Ask;
  payTo: PayToCheck;
  storedSession: boolean;
}) {
  const pinned = payTo.verdict === 'pinned';
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-primary">
        402: what the endpoint asks for
      </p>
      {ask.description && <p className="mt-1 text-sm text-muted">{ask.description}</p>}
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Amount">{ask.amountFormatted}</Row>
        <Row label="Asset">{ask.asset}</Row>
        {pinned && (
          <Row label="Pays to">
            {payTo.wallet}{' '}
            <span className="font-sans text-muted-2">(this agent&apos;s registry wallet)</span>
          </Row>
        )}
        <Row label="Network">{networkLabel(ask)}</Row>
        {ask.rail && <Row label="Rail">{ask.rail}</Row>}
        {ask.spender && <Row label="Permit2 spender">{ask.spender}</Row>}
        {ask.timeoutSeconds !== null && <Row label="Valid for">{ask.timeoutSeconds} s</Row>}
      </dl>
      {pinned ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-2">
          {storedSession
            ? 'A session for this agent is stored in this browser, but only its public half: the signer is stripped before storage on purpose, so this page cannot sign the payment.'
            : 'No session for this agent is stored in this browser, and a stored one keeps only its public half anyway, so this page cannot sign the payment.'}{' '}
          Paying needs an Altana session with its signer in hand (the activation flow grants
          one) or a wallet holding USDT with a Permit2 approval; what such a client signs is
          exactly the ask above, and the same request retried with the payment header returns
          the status.
        </p>
      ) : (
        <PayToRefused payTo={payTo} />
      )}
    </div>
  );
}

/**
 * The x402 status endpoint, made usable from the agent page: where it is, what
 * it costs, what comes back, and a button that asks the runner itself. The
 * endpoint arrives as a prop resolved on the server from the runner base, so
 * this component never decides where the runner is. The wallet the payment
 * must go to comes from the committed registry, never from the runner.
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
  const wallet = AGENTS[slug].wallet;
  const tag = statusTag(outcome);

  /**
   * The button is disabled while `outcome` is loading, so the one thing this
   * must guarantee is that the loading state is always replaced. `fetchStatus`
   * answers rather than throws, but it reads localStorage on the challenge
   * path, which a browser with site data blocked makes throw: without the
   * finally that would leave the button reading "Asking the runner…" with no
   * way back.
   */
  async function run() {
    setOutcome({ kind: 'loading', again: outcome.kind === 'offline' || outcome.kind === 'unexpected' });
    let next: Outcome = {
      kind: 'unexpected',
      detail: 'This page could not finish reading the answer.',
    };
    try {
      next = await fetchStatus(slug, tokenId);
    } catch {
      // Keep the fallback above; there is nothing more specific to say.
    } finally {
      setOutcome(next);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-2">
          x402 status endpoint
        </h2>
        {tag && <span className="text-[10px] text-muted-2">{tag}</span>}
      </div>
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
        <Row label="Pays to">
          {wallet ?? 'no registry wallet yet'}
          {wallet && (
            <>
              {' '}
              <span className="font-sans text-muted-2">(this agent&apos;s registry wallet)</span>
            </>
          )}
        </Row>
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
          <Challenge ask={outcome.ask} payTo={outcome.payTo} storedSession={outcome.storedSession} />
        )}
        {outcome.kind === 'paid' && (
          <pre className="overflow-x-auto rounded-lg border border-success/25 bg-success/5 p-3 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(outcome.payload, null, 2)}
          </pre>
        )}
        {outcome.kind === 'offline' && (
          <div className="rounded-lg border border-border bg-surface-2 p-4">
            <p className="text-sm font-medium text-foreground">Runner offline, on-chain data still live.</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-2">
              The status endpoint did not answer. Everything else on this page reads from
              BNB Chain and stays current; the endpoint comes back with the tunnel.
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
