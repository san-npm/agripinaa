'use client';

import { fromBaseUnits } from '@agripinaa/shared/tokens';
import type { FundingAsset } from '@/lib/funding-bootstrap';
import {
  FUNDING_ASSETS,
  type FundingBootstrapPlan,
  type FundingGasQuote,
} from '@/lib/funding-bootstrap';
import { useState } from 'react';

import { TokenLogo } from './icons';

function shortAmount(value: bigint, maximumFractionDigits = 6): string {
  const exact = fromBaseUnits(value, 18);
  const [whole, fraction = ''] = exact.split('.');
  const trimmed = fraction.slice(0, maximumFractionDigits).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

export function FundingDeposit({
  address,
  asset,
  balances,
  gasQuote,
  gasConversionRequired,
  preparedPlan,
  preparationStatus,
  preparationTransactionHash,
  quoteError,
  locked = false,
  onAssetChange,
}: {
  address: `0x${string}`;
  asset: FundingAsset;
  balances: Readonly<Record<FundingAsset, bigint | null>>;
  gasQuote: FundingGasQuote | null;
  gasConversionRequired: boolean;
  preparedPlan?: FundingBootstrapPlan | null;
  preparationStatus?: 'submitted' | 'confirmed';
  preparationTransactionHash?: `0x${string}`;
  quoteError: string | null;
  locked?: boolean;
  onAssetChange(asset: FundingAsset): void;
}) {
  const [copied, setCopied] = useState(false);
  const gross = preparedPlan?.grossInput ?? balances[asset];
  const reserveInput = preparedPlan?.gasReserveInput
    ?? (gasQuote && gasConversionRequired ? gasQuote.gasReserveInput : 0n);
  const bootstrapInput = preparedPlan?.bootstrapFeeInput
    ?? (gasQuote && gasConversionRequired ? gasQuote.bootstrapFeeInput : 0n);
  const allocation = reserveInput + bootstrapInput;
  const net = preparedPlan?.strategyInput
    ?? (gross != null && gross > allocation ? gross - allocation : 0n);

  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-2">Choose one deposit asset</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FUNDING_ASSETS.map((symbol) => (
            <button
              key={symbol}
              type="button"
              onClick={() => onAssetChange(symbol)}
              disabled={locked}
              aria-pressed={asset === symbol}
              className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-all disabled:cursor-not-allowed ${
                asset === symbol
                  ? 'border-primary/60 bg-primary/10 text-foreground shadow-[0_0_18px_rgba(245,158,11,0.14)]'
                  : 'border-border-strong text-muted-2 hover:border-primary/35 hover:text-foreground disabled:opacity-45'
              }`}
            >
              <TokenLogo symbol={symbol} className="h-6 w-6" />
              {symbol}
            </button>
          ))}
        </div>
      </div>

      {preparedPlan && preparationStatus && (
        <div role="status" aria-live="polite" aria-atomic="true" className={`rounded-lg border p-3 text-xs leading-relaxed ${
          preparationStatus === 'confirmed'
            ? 'border-success/25 bg-success/10 text-success'
            : 'border-primary/25 bg-primary/10 text-primary'
        }`}>
          <p className="font-semibold">
            {preparationStatus === 'confirmed' ? 'Funding confirmed' : 'Funding submitted'}
          </p>
          <p className="mt-1">
            {preparationStatus === 'confirmed'
              ? 'Your deposit is ready. Continue below to grant the agent mandate with one passkey confirmation. This funding transaction will not run again.'
              : 'The relay ID is saved. Use “Check funding status” below; retrying will not sign, swap, or charge this deposit again.'}
          </p>
          {preparationStatus === 'confirmed' && preparationTransactionHash && (
            <a
              href={`https://bscscan.com/tx/${preparationTransactionHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-medium underline decoration-success/50 underline-offset-2 hover:text-foreground"
            >
              View confirmed transaction on BscScan ↗
            </a>
          )}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface-2 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-2">Send {asset} once</p>
          <button
            type="button"
            onClick={copyAddress}
            className="rounded-md border border-border-strong px-2 py-1 text-xs text-muted transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </div>
        <code className="mt-2 block break-all text-xs text-primary">{address}</code>
        <p className="mt-2 text-xs leading-relaxed text-muted-2">
          One asset transfer only. Do not send a second asset or a separate BNB top-up. Activation
          prepares the deposit in one funding transaction, then grants the scoped agent mandate separately.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border" aria-live="polite">
        <div className="flex items-center justify-between bg-surface-2 px-3 py-2.5 text-sm">
          <span className="flex items-center gap-2 text-muted">
            <TokenLogo symbol={asset} className="h-5 w-5" /> Gross deposit
          </span>
          <span className="font-mono tabular text-foreground">
            {gross == null ? '…' : `${shortAmount(gross)} ${asset}`}
          </span>
        </div>
        <div className="divide-y divide-border border-t border-border bg-surface px-3 text-xs">
          <FundingLine
            label={`BNB provision (${gasQuote?.registrationCount ?? 2} key registrations + your reserve)`}
            value={gasQuote == null ? 'Quoting…' : `${shortAmount(reserveInput)} ${asset}`}
          />
          <FundingLine
            label="Activation relay fee (fixed)"
            value={gasQuote == null ? 'Quoting…' : `${shortAmount(bootstrapInput)} ${asset}`}
          />
          <FundingLine
            label="Available to strategy"
            value={gross == null || gasQuote == null ? '…' : `${shortAmount(net)} ${asset}`}
            strong
          />
          <FundingLine label="Agripinaa-funded amount" value="0" />
        </div>
      </div>

      {quoteError && (
        <p role="alert" className="rounded-lg border border-danger/35 bg-danger/10 p-3 text-xs text-danger">
          {quoteError}
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-2">
        The BNB provision covers the live Altana key-registration fees and leaves an operating reserve in
        your account; any unused BNB remains yours and is withdrawable. {asset === 'BNB'
          ? 'Your account pays its first relay operation from the displayed fixed budget.'
          : 'Before strategy preparation, a separately signed pre-call converts the displayed fixed cut into native BNB for the relay fee payer. That payment is retained even if a later strategy call reverts, so a retry never shifts gas cost to Agripinaa.'}{' '}
        Agripinaa does not sponsor gas. Remaining capital is prepared into the assets required by the selected
        agent with on-chain slippage protection.
      </p>
    </div>
  );
}

export function ActivationProgress({ phase }: { phase: string }) {
  return (
    <div
      id="activation-progress"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs leading-relaxed"
    >
      <p className="font-semibold text-primary">Activation in progress</p>
      <p className="mt-1 text-foreground">{phase || 'Working…'}</p>
      <p className="mt-1 text-muted">The action below is temporarily locked to prevent a duplicate transaction.</p>
    </div>
  );
}

function FundingLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-muted-2">{label}</span>
      <span className={`shrink-0 font-mono tabular ${strong ? 'font-semibold text-success' : 'text-muted'}`}>
        {value}
      </span>
    </div>
  );
}
