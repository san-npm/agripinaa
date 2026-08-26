'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { isAddress } from 'viem';

import {
  CLAIM_CATEGORY_OPTIONS,
  ownerStatus,
  prepareClaim,
  type ClaimFormValues,
  type DroppedLink,
  type OwnerStatus,
} from '@/lib/claim-form';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_URL_CHARS,
  buildClaimMessage,
  type ClaimFields,
} from '@/lib/claim-message';
import {
  endpointProbeLabel,
  probeCountsAsLive,
  readEndpointProbe,
  type EndpointProbe,
} from '@/lib/endpoint-probe';
import { NoWalletError, connectInjected, injectedProvider } from '@/lib/injected-wallet';

/**
 * The owner-facing half of the claim flow: connect an account, see whether it
 * is the address the registry says owns this agent, describe the agent, and
 * sign one EIP-712 message the server verifies against `ownerOf`.
 *
 * Two rules shape the whole component. The fields are sanitised before they are
 * signed, because the server verifies the signature over the sanitised fields
 * and a browser that signs its raw form values produces a signature that
 * recovers to nothing. And every message the server sends back is rendered as
 * it arrived: the endpoint already phrases its own refusals, and paraphrasing
 * them here would eventually tell an owner something the server did not decide.
 */

interface ClaimFormProps {
  chainId: number;
  tokenId: string;
  agentName: string;
  /** The owner address the page resolved, checksummed where the chain answered. */
  owner: string;
  /** False when the RPC did not answer and this is the indexer's owner instead. */
  ownerFromChain: boolean;
  /** The owner address carries bytecode, so no key can sign for it directly. */
  ownerIsContract: boolean;
  /** The claim already stored for this agent, so an update starts from it. */
  existing: ClaimFormValues | null;
}

const EMPTY: ClaimFormValues = {
  description: '',
  category: 'other',
  website: '',
  endpoint: '',
};

const primaryBtn =
  'rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)] disabled:opacity-50 disabled:shadow-none';
const inputCls =
  'w-full rounded-lg border border-border-strong bg-surface-2 p-2.5 text-sm focus:border-primary focus:outline-none';
const labelCls = 'mb-1 block text-xs uppercase tracking-wide text-muted-2';

export function ClaimForm({
  chainId,
  tokenId,
  agentName,
  owner,
  ownerFromChain,
  ownerIsContract,
  existing,
}: ClaimFormProps) {
  const [account, setAccount] = useState<string | null>(null);
  const [values, setValues] = useState<ClaimFormValues>(existing ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [stored, setStored] = useState<ClaimFields | null>(null);
  const [dropped, setDropped] = useState<DroppedLink[]>([]);
  // What our probe found about the endpoint that was just stored. The claim
  // POST runs one and answers with the result; before it was rendered here, an
  // owner whose endpoint timed out or answered 404 had no way to learn that.
  const [probe, setProbe] = useState<EndpointProbe | null>(null);

  // Read through useSyncExternalStore rather than in render: `window.ethereum`
  // does not exist on the server, and a bare check would make the server and
  // the first client render disagree about which of the two panels below shows.
  const hasWallet = useSyncExternalStore(subscribeNever, hasInjectedWallet, () => false);
  const status = account ? ownerStatus({ account, owner, ownerFromChain }) : null;

  function set<K extends keyof ClaimFormValues>(key: K, value: ClaimFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function fail(message: string, canRetry = false) {
    setError(message);
    setRetryable(canRetry);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    setRetryable(false);
    try {
      const { address } = await connectInjected();
      setAccount(address);
    } catch (e) {
      fail(e instanceof NoWalletError ? e.message : messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setRetryable(false);
    setStored(null);
    setProbe(null);
    try {
      // Reconnecting rather than holding a client in state: the account and the
      // network can both change in the wallet between connecting and signing,
      // and this is the point where a stale one would matter.
      const { address, client } = await connectInjected();
      setAccount(address);
      // Refused here only when the chain itself named a different owner. With
      // an owner that came from the index instead, a difference proves nothing
      // and blocking would lock out the current owner, who is exactly who this
      // form is for; the endpoint reads `ownerOf` and answers.
      if (ownerStatus({ account: address, owner, ownerFromChain }) === 'mismatch') {
        fail('connected wallet is not the owner of this agent');
        return;
      }

      const prepared = prepareClaim({
        chainId,
        tokenId,
        values,
        // Taken here rather than on mount: the server refuses a claim signed
        // more than ten minutes either side of its own clock.
        issuedAt: new Date().toISOString(),
      });
      const { fields } = prepared;
      if (!fields.description && !fields.website && !fields.endpoint) {
        fail('Fill in a description, a website, or an endpoint before signing.');
        return;
      }

      const signature = await client.signTypedData({
        account: address,
        ...buildClaimMessage(fields),
      });

      const response = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields, signature }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        claim?: { fields?: ClaimFields };
        liveness?: unknown;
      } | null;

      if (!response.ok) {
        // 503 means the chain or the store did not answer, which says nothing
        // about the claim itself, so the same submission is worth repeating.
        fail(body?.error ?? 'the claim could not be stored', response.status === 503);
        return;
      }
      setStored(body?.claim?.fields ?? fields);
      setProbe(readEndpointProbe(body?.liveness));
      setDropped(prepared.dropped);
    } catch (e) {
      fail(e instanceof NoWalletError ? e.message : messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (stored) {
    return (
      <StoredClaim
        href={`/agent/${chainId}/${tokenId}`}
        agentName={agentName}
        fields={stored}
        dropped={dropped}
        probe={probe}
      />
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-border bg-surface p-6">
      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Prove you own it</h2>
        <dl className="space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted-2">
              {ownerFromChain ? 'On-chain owner' : 'Owner in the index'}
            </dt>
            <dd className="break-all font-mono text-xs text-muted">{owner}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted-2">Connected</dt>
            <dd className="break-all font-mono text-xs text-muted">
              {account ?? 'no wallet connected'}
            </dd>
          </div>
        </dl>

        {!ownerFromChain && (
          <p className="text-xs leading-relaxed text-muted-2">
            This owner comes from the index rather than from the registry, so it may be behind
            the chain. Your signature is still checked against the registry when you submit.
          </p>
        )}

        {status && <p className={`text-xs ${STATUS_TONE[status]}`}>{STATUS_LINE[status]}</p>}

        {ownerIsContract && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm leading-relaxed text-danger">
            This agent is owned by a contract address, and claiming from a contract wallet is not
            supported yet. A claim has to be signed by an account that holds its own key.
          </p>
        )}

        {!hasWallet ? (
          <p className="text-sm text-muted">
            No browser wallet detected. Install a wallet extension, then reload this page.
          </p>
        ) : (
          !account && (
            <button type="button" onClick={connect} disabled={busy} className={primaryBtn}>
              {busy ? 'Connecting…' : 'Connect wallet'}
            </button>
          )
        )}
      </section>

      <section className="mt-6 space-y-4 border-t border-border pt-6">
        <div>
          <h2 className="font-display text-lg font-semibold">Describe {agentName}</h2>
          <p className="mt-1 text-sm text-muted">
            {existing
              ? 'This agent already carries a claim. Signing again replaces it.'
              : 'The registry carries none of this, so it is yours to fill in.'}
          </p>
        </div>

        <label className="block">
          <span className={labelCls}>Description</span>
          <textarea
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            maxLength={MAX_DESCRIPTION_CHARS}
            rows={4}
            placeholder="What this agent does, and for whom."
            className={inputCls}
          />
          <span className="mt-1 block text-xs text-muted-2">
            {values.description.length} of {MAX_DESCRIPTION_CHARS} characters
          </span>
        </label>

        <label className="block">
          <span className={labelCls}>Category</span>
          <select
            value={values.category}
            onChange={(e) => set('category', e.target.value as ClaimFormValues['category'])}
            className={inputCls}
          >
            {CLAIM_CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className={labelCls}>Website</span>
          <input
            type="url"
            inputMode="url"
            value={values.website}
            onChange={(e) => set('website', e.target.value)}
            maxLength={MAX_URL_CHARS}
            placeholder="https://example.com"
            className={`${inputCls} font-mono text-xs`}
          />
        </label>

        <label className="block">
          <span className={labelCls}>Endpoint</span>
          <input
            type="url"
            inputMode="url"
            value={values.endpoint}
            onChange={(e) => set('endpoint', e.target.value)}
            maxLength={MAX_URL_CHARS}
            placeholder="https://example.com/a2a"
            className={`${inputCls} font-mono text-xs`}
          />
          <span className="mt-1 block text-xs text-muted-2">
            https only. A link on a private or loopback address is dropped rather than stored.
          </span>
        </label>

        <button
          type="submit"
          // strict:false on purpose: the index can hand back a lowercase
          // address, and only the shape matters for deciding whether there is
          // an owner to compare against at all.
          disabled={busy || !hasWallet || !isAddress(owner, { strict: false })}
          className={primaryBtn}
        >
          {busy ? 'Waiting for your wallet…' : 'Sign and submit claim'}
        </button>

        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <p>{error}</p>
            {retryable && (
              <p className="mt-1 text-xs text-muted-2">
                Nothing was stored. Submitting again is safe.
              </p>
            )}
          </div>
        )}
      </section>
    </form>
  );
}

const STATUS_TONE: Record<OwnerStatus, string> = {
  match: 'text-success',
  mismatch: 'text-danger',
  unconfirmed: 'text-muted',
};

const STATUS_LINE: Record<OwnerStatus, string> = {
  match: 'This account matches the owner shown above.',
  mismatch: 'connected wallet is not the owner of this agent',
  unconfirmed:
    'This account does not match the owner the index reported. The registry decides when you submit.',
};

const subscribeNever = () => () => {};
const hasInjectedWallet = () => injectedProvider() !== null;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // Wallet rejections arrive as long provider errors; the first line is the
    // part a person can act on, and the rest is a stack of RPC detail.
    return error.message.split('\n')[0] ?? 'The wallet did not complete the request.';
  }
  return 'The wallet did not complete the request.';
}

/**
 * What landed. The stored fields are rendered as text and never as markup: this
 * is the one place on the site where a stranger's string reaches a page.
 */
function StoredClaim({
  href,
  agentName,
  fields,
  dropped,
  probe,
}: {
  href: string;
  agentName: string;
  fields: ClaimFields;
  dropped: DroppedLink[];
  probe: EndpointProbe | null;
}) {
  const category = CLAIM_CATEGORY_OPTIONS.find((option) => option.value === fields.category);
  return (
    <div className="rounded-2xl border border-success/40 bg-surface p-6">
      <h2 className="font-display text-lg font-semibold text-success">
        {agentName} is claimed
      </h2>
      <p className="mt-1 text-sm text-muted">
        Signed by the on-chain owner and stored. The listing picks it up within a few minutes.
      </p>

      <dl className="mt-5 space-y-3 text-sm">
        <Stored label="Description" value={fields.description} />
        <Stored label="Category" value={category?.label ?? fields.category} />
        <Stored label="Website" value={fields.website} mono />
        <Stored
          label="Endpoint"
          value={fields.endpoint}
          mono
          note={fields.endpoint ? endpointNote(probe, fields.endpoint) : undefined}
        />
      </dl>

      {dropped.length > 0 && (
        <p className="mt-4 rounded-lg border border-border-strong bg-surface-2 p-3 text-xs leading-relaxed text-muted">
          Stored without the {dropped.join(' and ')} you typed: only an https link to a public
          host is kept. Sign again with a corrected link to add it.
        </p>
      )}

      <Link href={href} className={`mt-5 inline-block ${primaryBtn}`}>
        Back to the listing
      </Link>
    </div>
  );
}

function Stored({
  label,
  value,
  mono,
  note,
}: {
  label: string;
  value: string;
  mono?: boolean;
  note?: string;
}) {
  return (
    <div>
      <dt className={labelCls}>{label}</dt>
      <dd className={`break-words ${mono ? 'font-mono text-xs text-muted' : 'text-foreground'}`}>
        {value || <span className="text-muted-2">not set</span>}
      </dd>
      {note && <p className="mt-1 text-xs leading-relaxed text-muted-2">{note}</p>}
    </div>
  );
}

/**
 * What our probe found about the endpoint that was just stored, and what the
 * owner can do about it. The verdict wording is the same one the agent profile
 * renders, so the two surfaces cannot describe one endpoint differently.
 */
function endpointNote(probe: EndpointProbe | null, endpoint: string): string {
  const label = endpointProbeLabel(probe, endpoint);
  return probeCountsAsLive(probe, endpoint)
    ? `${label}. The listing carries a live badge for as long as an answer stays inside 36 hours.`
    : `${label}. Sign again once it answers to re-check it, or wait for the next scheduled probe.`;
}
