import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import { signerFromPrivateKey, type Client, type Session } from '@altananetwork/sdk';
import {
  encodeFunctionData,
  type Abi,
  type Account,
  type Hex,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import {
  loadManaged,
  managedHealthKey,
  removeManagedEntry,
  type ManagedHealth,
} from './managed';
import { healthAfterManagedTick, managedSweepBatch } from './managed-runner';
import type { ManagerKey } from './manager-key';
import type { AgentContext, AgentModule, AgentState, Breakers } from './types';

function scopedTarget(entry: ReturnType<typeof loadManaged>[number]): Hex | undefined {
  const call = entry.session.permissions.calls?.[0];
  const target = call && 'to' in call ? call.to : undefined;
  return typeof target === 'string' ? target as Hex : undefined;
}

function managedSession(entry: ReturnType<typeof loadManaged>[number], managerKey: ManagerKey): Session {
  if (privateKeyToAccount(managerKey.privateKey).publicKey.toLowerCase() !== entry.session.publicKey.toLowerCase()) {
    throw new Error('manager key does not match the granted session public key');
  }
  return {
    walletAddress: entry.session.walletAddress,
    signer: signerFromPrivateKey(managerKey.privateKey),
    publicKey: entry.session.publicKey,
    permissions: entry.session.permissions,
    expiry: entry.session.expiry,
  };
}

function namespacedState(base: AgentState, account: Hex): AgentState {
  const prefix = `managed:${account.toLowerCase()}:`;
  return {
    get<T>(key: string, fallback: T): T { return base.get(`${prefix}${key}`, fallback); },
    set(key: string, value: unknown): void { base.set(`${prefix}${key}`, value); },
  };
}

function managedBreakers(state: AgentState, log: AgentContext['log']): Breakers {
  return {
    halt(reason) {
      state.set('halted', { reason, at: new Date().toISOString() });
      log({ event: 'managed-account-halt', reason });
    },
    isHalted() {
      const halted = state.get<{ reason: string } | null>('halted', null);
      return halted ? { halted: true, reason: halted.reason } : { halted: false };
    },
    allowAction(kind, maxPerDay) {
      const now = Date.now();
      const current = state.get<number[]>(`actions:${kind}`, []).filter((at) => at > now - 24 * 3600 * 1000);
      if (current.length >= maxPerDay) return false;
      state.set(`actions:${kind}`, [...current, now]);
      return true;
    },
    releaseAction(kind) {
      const current = state.get<number[]>(`actions:${kind}`, []);
      if (current.length > 0) state.set(`actions:${kind}`, current.slice(0, -1));
    },
  };
}

/**
 * Present an Altana session as the small viem WalletClient surface the six
 * existing strategy modules already use. Every write still goes through the
 * account's on-chain selector/spend policy; off-chain Ophis typed data is
 * wrapped as the account's ERC-1271 signature by the SDK.
 */
function sessionWallet(client: Client, session: Session, chainId: number): WalletClient {
  return {
    chain: bsc,
    __ophisSigningScheme: 'eip1271',
    async writeContract(args: {
      address: Hex;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
    }) {
      const data = encodeFunctionData({
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      } as never);
      const result = await client.execute({
        session,
        chainId,
        calls: [{ to: args.address, data }],
      });
      if (result.status !== 'CONFIRMED' || !result.transactionHash) {
        throw new Error(
          result.status === 'PENDING'
            ? `${args.functionName} is still pending at the relay`
            : `${args.functionName} failed at the relay`,
        );
      }
      return result.transactionHash;
    },
    async signTypedData(args: Record<string, unknown>) {
      return client.signOrderTypedData({
        session,
        typedData: {
          domain: args.domain as never,
          types: args.types as never,
          primaryType: String(args.primaryType),
          message: args.message as Record<string, unknown>,
        },
      });
    },
  } as unknown as WalletClient;
}

export function buildManagedStrategyContext(opts: {
  base: AgentContext;
  client: Client;
  entry: ReturnType<typeof loadManaged>[number];
  managerKey: ManagerKey;
}): AgentContext {
  const { base, client, entry, managerKey } = opts;
  const session = managedSession(entry, managerKey);
  const state = namespacedState(base.state, entry.account);
  // The own-capital Aave guardian creates a small drill position on first boot.
  // A public mandate must only adopt an existing user position, never borrow.
  if (base.name === 'health-factor' && !state.get('setupDone', false)) state.set('setupDone', true);
  const log: AgentContext['log'] = (event) => base.log({ managedAccount: entry.account, ...event });
  return {
    name: base.name,
    chainId: entry.chainId,
    account: { address: entry.account, type: 'json-rpc' } as Account,
    publicClient: base.publicClient,
    walletClient: sessionWallet(client, session, entry.chainId),
    log,
    state,
    breakers: managedBreakers(state, log),
  };
}

export async function tickManagedStrategy(opts: {
  ctx: AgentContext;
  module: AgentModule;
  client: Client;
  managerKey: ManagerKey;
}): Promise<{ serviced: number; errors: number }> {
  const all = loadManaged(opts.ctx.name);
  const cursorKey = 'managed:strategySweepCursor';
  const batch = managedSweepBatch(all, opts.ctx.state.get<number>(cursorKey, 0));
  opts.ctx.state.set(cursorKey, batch.nextCursor);
  let serviced = 0;
  let errors = 0;
  let cursor = 0;
  const work = async () => {
    while (cursor < batch.entries.length) {
      const entry = batch.entries[cursor++]!;
      const target = scopedTarget(entry);
      try {
        if (entry.session.expiry * 1000 <= Date.now()) {
          removeManagedEntry(opts.ctx.name, entry);
          continue;
        }
        if (!target) throw new Error('managed strategy has no concrete scoped target');
        const live = await isSessionKeyValid({
          chainId: entry.chainId,
          account: entry.account,
          sessionPublicKey: entry.session.publicKey,
        });
        if (!live) {
          removeManagedEntry(opts.ctx.name, entry);
          continue;
        }
        const managedCtx = buildManagedStrategyContext({
          base: opts.ctx,
          client: opts.client,
          entry,
          managerKey: opts.managerKey,
        });
        const halted = managedCtx.breakers.isHalted();
        if (halted.halted) {
          opts.ctx.state.set(managedHealthKey(entry.account, target), {
            at: Date.now(),
            result: 'error',
            reason: `managed account halted: ${halted.reason}`,
          } satisfies ManagedHealth);
          continue;
        }
        await opts.module.tick(managedCtx);
        const key = managedHealthKey(entry.account, target);
        opts.ctx.state.set(
          key,
          healthAfterManagedTick(opts.ctx.state.get<ManagedHealth | null>(key, null), undefined),
        );
        serviced += 1;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        if (target) opts.ctx.state.set(managedHealthKey(entry.account, target), {
          at: Date.now(), result: 'error', reason,
        } satisfies ManagedHealth);
        opts.ctx.log({ event: 'managed-strategy-error', account: entry.account, error: reason });
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batch.entries.length) }, () => work()));
  return { serviced, errors };
}
