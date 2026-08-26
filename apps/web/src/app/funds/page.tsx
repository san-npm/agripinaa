import { ROUTER_ACTIONS, YIELD_ROUTERS_BSC } from '@agripinaa/shared/contracts';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ShieldIcon } from '@/components/icons';
import { RouterPanel } from '@/components/RouterPanel';
import { clampDescription } from '@/lib/site';

const DESCRIPTION = clampDescription(
  'AgripinaaYieldRouter deployments on BNB Smart Chain: addresses, bounded router-visible balances, recent rotations, and managed-session security.',
);

export const metadata: Metadata = {
  title: 'Managed funds · Agripinaa',
  description: DESCRIPTION,
  openGraph: { title: 'Managed funds · Agripinaa', description: DESCRIPTION },
};

function PanelSkeleton({ symbol }: { symbol: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="font-display text-lg font-semibold">{symbol} router</h2>
      <p className="mt-1 text-xs text-muted-2">Reading balances and rotation history from BNB Smart Chain.</p>
    </section>
  );
}

function Claim({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-border bg-surface-2 p-4">
      <h3 className="font-display text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{children}</p>
    </li>
  );
}

export default function FundsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <span className="grid h-11 w-11 place-items-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
        <ShieldIcon className="h-5 w-5" />
      </span>
      <h1 className="mt-4 font-display text-3xl font-semibold">Managed funds, in the open</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        When you hand Agripinaa&apos;s yield agent a session key, the key is scoped to
        one contract: the AgripinaaYieldRouter. Your funds never leave your own
        smart account, and the agent&apos;s only power is to move them between Aave,
        Venus, and idle. Both deployments are below with their balances and their
        most recent rotations, each panel stating the block its scan reaches back
        to, so you can check that before you deposit anything, and audit it
        afterwards.
      </p>

      <div className="mt-8 space-y-6">
        {YIELD_ROUTERS_BSC.map((router) => (
          <Suspense key={router.address} fallback={<PanelSkeleton symbol={router.symbol} />}>
            <RouterPanel router={router} />
          </Suspense>
        ))}
      </div>

      <section className="mt-12">
        <h2 className="font-display text-xl font-semibold">
          Why a compromised agent key cannot drain these funds
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A session key on BNB Smart Chain can be scoped to a target contract and a
          set of selectors, but not to the arguments of a call. Scope an agent to
          Aave&apos;s <span className="font-mono text-xs">withdraw(asset, amount, to)</span> and
          it picks <span className="font-mono text-xs">to</span> itself. The router
          exists to take that choice away. Every claim below is in{' '}
          <span className="font-mono text-xs">contracts/src/AgripinaaYieldRouter.sol</span>.
        </p>
        <ul className="mt-4 space-y-3">
          <Claim title="Three entrypoints, none of which takes an argument">
            <span className="font-mono text-xs">toAave()</span> ({ROUTER_ACTIONS.toAave.selector}),{' '}
            <span className="font-mono text-xs">toVenus()</span> ({ROUTER_ACTIONS.toVenus.selector}), and{' '}
            <span className="font-mono text-xs">toIdle()</span> ({ROUTER_ACTIONS.toIdle.selector}).
            A key scoped to this address and these three selectors has nothing left
            to choose beyond which of the three to call.
          </Claim>
          <Claim title="Every recipient is hardcoded to msg.sender">
            Aave mints its aTokens straight to the calling account, the Venus
            vTokens minted in a call are transferred back to it, and an unwind
            sends the stablecoin back to it. The contract has no address parameter
            anywhere for a caller to point at itself.
          </Claim>
          <Claim title="Delta accounting, so a donation cannot be swept">
            <span className="font-mono text-xs">_unwindAllToUsdt</span> records the
            router&apos;s balance on entry and pays out only what that call brought
            in. Anything sitting in the router beforehand, whether a stray transfer
            or a deliberate donation, stays where it is. This is the fix for audit
            finding L-1, and it is why the router being empty is a property rather
            than a coincidence.
          </Claim>
          <Claim title="No owner, no admin, no upgrade path">
            No owner variable, no privileged role, no proxy, no{' '}
            <span className="font-mono text-xs">delegatecall</span>, no{' '}
            <span className="font-mono text-xs">selfdestruct</span>. The runtime
            bytecode of both deployments above matched the compiled source when the
            audit checked it, and immutability means it stays matched.
          </Claim>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold">What the fuzzers checked</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          <span className="font-mono text-xs">contracts/test/fuzz/RouterFuzz.sol</span>{' '}
          drives deposits, rotations, withdrawals, and out-of-band donations across
          three independent actors, against mocks of BSC USDT, Aave V3, and Venus.
          It asserts two properties:
        </p>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
          <li className="rounded-lg border border-border bg-surface-2 p-3">
            <span className="font-mono text-xs text-foreground">echidna_no_actor_exceeds_deposits</span>:
            no actor ever holds more value than they deposited, so an attacker who
            deposited nothing ends with nothing, and nobody sweeps another
            actor&apos;s principal.
          </li>
          <li className="rounded-lg border border-border bg-surface-2 p-3">
            <span className="font-mono text-xs text-foreground">echidna_router_holds_only_donations</span>:
            the router never custodies more than what was donated to it.
          </li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Echidna and Medusa each completed a 60,000 case campaign with both
          properties holding, alongside 13 fork tests against BNB Smart Chain state
          and a 30 day fork run confirming yield reaches the account while donated
          aTokens and vTokens stay untouched.
        </p>
      </section>

      <section className="mt-10 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-display text-xl font-semibold">Debt guard deployment</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A compromised session key cannot move funds anywhere except back to their
          owner. That is the property the design above enforces and the fuzzing
          covers, and it is the whole claim: not that a compromised key is
          harmless, only that it has nowhere to send anything.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The guarded deployments above reject a receipt-token unwind whenever
          the source lending venue reports debt.{' '}
          <span className="font-mono text-xs">_unwindAllToUsdt</span> pulls an
          account&apos;s receipt token out of its lending venue. If that same account
          has also borrowed in that venue and the receipt token is what secures the
          debt, an older deployment could strip collateral and leave the position
          open to liquidation. Both immutable routers were replaced on 2026-08-26;
          the addresses above are the guarded builds and managed activation scopes
          only to them.
        </p>
      </section>

      <p className="mt-8 text-xs leading-relaxed text-muted-2">
        Source: <span className="font-mono">contracts/src/AgripinaaYieldRouter.sol</span>,{' '}
        <span className="font-mono">contracts/test/AgripinaaYieldRouter.t.sol</span>, and{' '}
        <span className="font-mono">contracts/test/fuzz/RouterFuzz.sol</span> in this
        repository. Balances and rotations on this page are read from BNB Smart
        Chain, not from any indexer of ours.
      </p>
    </div>
  );
}
