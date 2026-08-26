import { bscScanAddress, bscScanTx } from '@agripinaa/shared';
import type { RouterDeployment } from '@agripinaa/shared/contracts';

import { groupDigits, readRouterFunds, underManagementNote, type RotationRow } from '@/lib/funds';
import { FreshnessStamp } from './FreshnessStamp';

/** How many rotations the panel lists before it stops. */
const MAX_ROWS = 25;

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function stampTime(iso: string): string {
  return `${new Date(iso).toUTCString().slice(17, 25)} UTC`;
}

function rowDate(row: RotationRow): string {
  if (!row.at) return `block ${groupDigits(row.blockNumber)}`;
  const at = new Date(row.at).toUTCString();
  return `${at.slice(5, 16)} ${at.slice(17, 22)} UTC`;
}

function Stat({ label, value, unit, note }: { label: string; value: string; unit?: string; note: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-2">{label}</dt>
      <dd className="tabular mt-1 font-mono text-lg font-medium text-foreground">
        {value}
        {unit ? <span className="ml-1 text-xs text-muted">{unit}</span> : null}
      </dd>
      <dd className="mt-1 text-[11px] leading-snug text-muted-2">{note}</dd>
    </div>
  );
}

function ExplorerLink({
  href,
  className = '',
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`font-mono text-muted underline decoration-border-strong underline-offset-2 transition-colors hover:text-foreground ${className}`}
    >
      {children}
    </a>
  );
}

/**
 * One deployed router, in public: its address, when it went live, what the
 * accounts it manages are holding, and its most recent rotations (the list is
 * capped at MAX_ROWS, and the footer under it names the total the scan found).
 * Server component, so a visitor sees all of it without connecting a wallet.
 */
export async function RouterPanel({ router }: { router: RouterDeployment }) {
  const funds = await readRouterFunds(router.symbol);
  const deployBlock = router.deployBlock.toString();
  const scannedFrom = funds.scannedFrom ?? deployBlock;
  const fromDeployment = scannedFrom === deployBlock;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-lg font-semibold">
          {router.symbol} router
        </h2>
        <ExplorerLink
          href={bscScanAddress(router.chainId, router.address)}
          className="break-all text-xs"
        >
          {router.address}
        </ExplorerLink>
      </div>
      <p className="mt-1 text-xs text-muted-2">
        Live on BNB Smart Chain since {router.deployedOn}, created in block{' '}
        {groupDigits(deployBlock)}.
        {funds.scannedFrom == null
          ? ''
          : fromDeployment
            ? ' The rotation scan below covers every block since.'
            : ` The rotation history below is scanned from block ${groupDigits(scannedFrom)}, the oldest block this scan reaches.`}
      </p>

      {funds.managed || funds.custody != null ? (
        <dl className={`mt-4 grid gap-3 ${funds.managed ? 'sm:grid-cols-3' : 'sm:max-w-xs'}`}>
          {funds.managed ? (
            <>
              <Stat
                label="Router-visible holdings"
                value={funds.managed.total}
                unit={router.symbol}
                note={underManagementNote({
                  accounts: funds.managed.accounts,
                  scannedFrom: funds.scannedFrom,
                  deployBlock,
                })}
              />
              <Stat
                label="Working in a venue"
                value={funds.managed.deployed}
                unit={router.symbol}
                note={`aToken and Venus balances for the bounded activity set. The remaining ${funds.managed.idle} sits idle.`}
              />
            </>
          ) : null}
          {funds.custody != null ? (
            <Stat
              label="Inside the router"
              value={funds.custody}
              unit={router.symbol}
              note="The router custodies nothing between calls: it pulls a position in, rotates it, and hands the result back within the same transaction."
            />
          ) : null}
        </dl>
      ) : null}
      {funds.managed ? (
        <FreshnessStamp asOf={funds.asOf} source="BNB Smart Chain" />
      ) : (
        <p className="mt-4 rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted">
          Balances unavailable: the total under management is summed over the
          bounded nonzero accounts in this router&apos;s Rotated event log, and that scan did not come
          back, checked {stampTime(funds.asOf)}. The addresses above and the security
          notes below come from the repository and the deployed bytecode, so they do
          not depend on it.
        </p>
      )}

      <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-2">
        Rotation history
      </h3>
      {funds.rotations == null ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-2">
          The Rotated event log could not be read, checked {stampTime(funds.asOf)}.
          Nothing is listed rather than a partial history.
        </p>
      ) : funds.rotations.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-2">
          No rotations yet. This router has emitted no Rotated event between block{' '}
          {groupDigits(scannedFrom)} and block {groupDigits(funds.scannedTo ?? scannedFrom)}.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {funds.rotations.slice(0, MAX_ROWS).map((row) => (
            <li
              key={`${row.blockNumber}-${row.logIndex}`}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-2 p-2.5 text-xs"
            >
              <span className="text-muted-2">{rowDate(row)}</span>
              <span className="font-medium text-foreground">{row.action}</span>
              <span className="tabular font-mono text-muted">
                {row.amount} {router.symbol}
              </span>
              <span className="text-muted-2">
                for <ExplorerLink href={bscScanAddress(router.chainId, row.account)}>{shorten(row.account)}</ExplorerLink>
              </span>
              <ExplorerLink href={bscScanTx(router.chainId, row.txHash)}>receipt</ExplorerLink>
            </li>
          ))}
        </ul>
      )}
      {funds.rotations && funds.rotations.length > MAX_ROWS ? (
        <p className="mt-2 text-[11px] text-muted-2">
          Showing the {MAX_ROWS} most recent of {funds.rotations.length} rotations.
        </p>
      ) : null}
    </section>
  );
}
