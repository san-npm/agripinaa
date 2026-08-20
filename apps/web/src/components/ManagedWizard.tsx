'use client';

import { routerFor } from '@agripinaa/shared/contracts';
import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, erc20Abi, http } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

import { altanaClient, SUPPORTED_CHAINS } from '@/lib/altana';
import {
  approveRouter,
  buildManagedScope,
  describeScope,
  fetchManagerKey,
  registerManaged,
  verifyOnlyStub,
} from '@/lib/managed';
import { storeSession } from '@/lib/session-store';
import { toast } from '@/lib/toast';
import { CoinsIcon, LightningIcon, ShieldIcon, VerifiedIcon } from './icons';

type Step = 'wallet' | 'deposit' | 'active';

/** Native balance needed before activation (approvals + key registration + margin). */
const MIN_NATIVE = 3_000_000_000_000_000n; // 0.003 BNB

interface ManagedAgentProps {
  chainId: number;
  tokenId: string;
  name: string;
  /** Runner agent name for the manage/manager-key endpoints (e.g. "yield"). */
  managedAgent: string;
}

type PasskeyWallet = Awaited<
  ReturnType<ReturnType<typeof altanaClient>['createPasskeyWallet']>
>;

export function ManagedWizard({ agent }: { agent: ManagedAgentProps }) {
  const [step, setStep] = useState<Step>('wallet');
  const [chainId, setChainId] = useState<number>(56);
  const [wallet, setWallet] = useState<PasskeyWallet | null>(null);
  const [nativeBal, setNativeBal] = useState<bigint | null>(null);
  const [usdtBal, setUsdtBal] = useState<bigint | null>(null);
  const [amount, setAmount] = useState<string>('10');
  const [hours, setHours] = useState<number>(168);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>('');

  const usdtAddress = routerFor(chainId)?.usdt;

  const publicClient = useCallback(
    () => createPublicClient({ chain: chainId === 97 ? bscTestnet : bsc, transport: http() }),
    [chainId],
  );

  async function connectPasskey(mode: 'create' | 'recover') {
    setBusy(true);
    setError(null);
    try {
      const client = altanaClient();
      const w =
        mode === 'create'
          ? await client.createPasskeyWallet({ name: 'Agripinaa' })
          : await client.recoverFromPasskey();
      setWallet(w);
      setStep('deposit');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (step !== 'deposit' || !wallet || !usdtAddress) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [n, u] = await Promise.all([
          publicClient().getBalance({ address: wallet.address as `0x${string}` }),
          publicClient().readContract({
            address: usdtAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address as `0x${string}`],
          }),
        ]);
        if (!cancelled) {
          setNativeBal(n);
          setUsdtBal(u);
        }
      } catch {
        /* transient RPC failure; next tick retries */
      }
    };
    void tick();
    const t = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [step, wallet, publicClient, usdtAddress]);

  async function activate() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Approve the router to move the account's USDT + aToken + vToken.
      setPhase('Approving the router (1 passkey tap)…');
      await approveRouter(wallet, chainId);

      // 2. Fetch the agent's manager key and grant a router-scoped session to
      //    it via a verify-only stub (the agent key never enters the browser).
      setPhase('Granting the managed session (1 passkey tap)…');
      const manager = await fetchManagerKey(agent.managedAgent);
      const capUsdt = String(Math.max(50, Math.ceil(Number(amount) * 10)));
      const scope = buildManagedScope({ chainId, capUsdt, hours });
      const client = altanaClient();
      const session = await client.grantSession({
        wallet,
        signer: wallet.signer,
        chainId,
        sessionSigner: verifyOnlyStub(manager.address, manager.publicKey) as never,
        ...scope,
      });

      // 3. Register the account so the agent starts managing it.
      setPhase('Handing the mandate to the agent…');
      await registerManaged(agent.managedAgent, {
        account: wallet.address as `0x${string}`,
        chainId,
        session,
      });

      // Keep a local record so the dashboard can show + revoke it.
      const summary = describeScope(scope);
      const router = routerFor(chainId)!;
      storeSession({
        session,
        chainId,
        agent: { chainId: agent.chainId, tokenId: agent.tokenId, name: agent.name },
        scope: { allowlist: [router.address], capFormatted: summary.capFormatted, expiresAt: summary.expiresAt },
      });
      setStep('active');
      toast({ title: 'Funds under management', detail: `${agent.name} is now working your deposit`, kind: 'success' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: 'Activation failed', detail: msg.slice(0, 80), kind: 'error' });
    } finally {
      setBusy(false);
      setPhase('');
    }
  }

  const fmt = (v: bigint | null) => (v == null ? '…' : (Number(v) / 1e18).toFixed(4));
  const gasReady = nativeBal != null && nativeBal >= MIN_NATIVE;
  const usdtReady = usdtBal != null && usdtBal >= BigInt(Math.floor(Number(amount) * 1e18 || 0));
  const stepIndex = { wallet: 0, deposit: 1, active: 2 }[step];
  const primaryBtn =
    'rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-[0_0_20px_rgba(245,158,11,0.35)] transition-all hover:bg-[var(--primary-050)] disabled:opacity-50 disabled:shadow-none';

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-2xl border border-border bg-surface p-6">
        <Stepper current={stepIndex} />

        {step === 'wallet' && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Your managed account</h2>
              <p className="mt-1 text-sm text-muted">
                Funds stay in a smart account secured by your passkey. {agent.name}{' '}
                gets a scoped key that can only route your USDT between lending
                venues, never send it anywhere but back to you.
              </p>
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-2">Network</p>
              <div className="inline-flex rounded-lg border border-border-strong p-0.5">
                {SUPPORTED_CHAINS.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setChainId(c.id)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      chainId === c.id ? 'bg-primary/15 text-primary' : 'text-muted-2 hover:text-foreground'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-3 pt-1">
              <button onClick={() => connectPasskey('create')} disabled={busy} className={primaryBtn}>
                {busy ? 'Waiting for passkey…' : 'Create with passkey'}
              </button>
              <button
                onClick={() => connectPasskey('recover')}
                disabled={busy}
                className="rounded-lg border border-border-strong px-4 py-2.5 text-sm transition-colors hover:border-primary/40 disabled:opacity-50"
              >
                I already have one
              </button>
            </div>
          </section>
        )}

        {step === 'deposit' && wallet && (
          <section className="mt-6 space-y-4">
            <div>
              <h2 className="font-display text-lg font-semibold">Deposit + gas</h2>
              <p className="mt-1 text-sm text-muted">
                Send USDT (the funds to manage) and a little {chainId === 97 ? 'tBNB' : 'BNB'}{' '}
                for gas to your account:
              </p>
            </div>
            <p className="break-all rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs">
              {wallet.address}
            </p>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-muted-2">
                Amount to put to work (USDT)
              </span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular w-32 rounded-lg border border-border-strong bg-surface-2 p-2.5 font-mono text-sm focus:border-primary focus:outline-none"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <Balance label="USDT" value={usdtBal == null ? '…' : fmt(usdtBal)} ready={usdtReady} />
              <Balance
                label={chainId === 97 ? 'tBNB (gas)' : 'BNB (gas)'}
                value={fmt(nativeBal)}
                ready={gasReady}
              />
            </div>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-muted-2">Mandate expires after</span>
              <div className="inline-flex rounded-lg border border-border-strong p-0.5">
                {[
                  { h: 24, label: '24h' },
                  { h: 168, label: '7d' },
                  { h: 720, label: '30d' },
                ].map((o) => (
                  <button
                    key={o.h}
                    onClick={() => setHours(o.h)}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      hours === o.h ? 'bg-primary/15 text-primary' : 'text-muted-2 hover:text-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </label>
            <button onClick={activate} disabled={busy || !gasReady || !usdtReady} className={primaryBtn}>
              {busy ? phase || 'Working…' : 'Put funds under management'}
            </button>
            <p className="text-xs text-muted-2">
              Two passkey taps: one approves the router, one grants the scoped
              session. You can withdraw or revoke any time from your dashboard.
            </p>
          </section>
        )}

        {step === 'active' && (
          <section className="mt-6 space-y-4">
            <div className="flex items-center gap-2">
              <VerifiedIcon className="h-6 w-6 text-success" />
              <h2 className="font-display text-lg font-semibold text-success">Funds under management</h2>
            </div>
            <p className="text-sm text-muted">
              {agent.name} now reads Venus and Aave each cycle and keeps your USDT
              in the higher-yielding venue. Your funds never leave your account;
              track the position and withdraw from your dashboard.
            </p>
            <a href="/dashboard" className={`inline-block ${primaryBtn}`}>
              Open dashboard
            </a>
          </section>
        )}

        {error && (
          <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</p>
        )}
      </div>

      <aside className="rounded-2xl border border-border bg-[linear-gradient(180deg,rgba(139,92,246,0.05),transparent_45%)] p-6">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-2">How your funds are protected</h3>
        <ul className="mt-4 space-y-4 text-sm">
          <Assurance icon={<ShieldIcon className="h-5 w-5" />} title="Can't be drained">
            The agent may call only the Router, and every Router action returns
            funds to your account, never to a third party.
          </Assurance>
          <Assurance icon={<CoinsIcon className="h-5 w-5" />} title="Non-custodial">
            Your USDT (or its aToken/vToken) always sits in your own passkey
            account. We never hold it.
          </Assurance>
          <Assurance icon={<LightningIcon className="h-5 w-5" />} title="Withdraw anytime">
            One tap unwinds to plain USDT in your account; revoking the session
            stops the agent instantly.
          </Assurance>
          <Assurance icon={<VerifiedIcon className="h-5 w-5" />} title="On-chain enforced">
            The scope and expiry are enforced by the account contract, not by us.
          </Assurance>
        </ul>
      </aside>
    </div>
  );
}

function Balance({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm">
      <span className="text-muted-2">{label}</span>
      <span className={`tabular font-mono ${ready ? 'text-success' : 'text-muted'}`}>
        {value}
        {ready && ' ✓'}
      </span>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  const steps = ['Account', 'Deposit', 'Active'];
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-medium ${
                done
                  ? 'border-primary bg-primary text-on-primary'
                  : active
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border-strong text-muted-2'
              }`}
            >
              {done ? '✓' : i + 1}
            </span>
            <span className={`text-sm ${active || done ? 'text-foreground' : 'text-muted-2'}`}>{label}</span>
            {i < steps.length - 1 && <span className={`h-px flex-1 ${done ? 'bg-primary/50' : 'bg-border'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Assurance({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-primary">
        {icon}
      </span>
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-2">{children}</p>
      </div>
    </li>
  );
}
