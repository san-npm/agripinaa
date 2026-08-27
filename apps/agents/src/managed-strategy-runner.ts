import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import {
  RELAY_URL,
  TESTNET_RELAY_URL,
  signerFromPrivateKey,
  type Client,
  type Session,
} from '@altananetwork/sdk';
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
  managedAccountStateKey,
  managedHealthKey,
  MAX_MANAGED_ENTRIES_PER_AGENT,
  removeManagedEntry,
  type ManagedHealth,
} from './managed';
import {
  healthAfterManagedTick,
  managedSweepBatch,
  MAX_MANAGED_ENTRIES_PER_SWEEP,
} from './managed-runner';
import type { ManagerKey } from './manager-key';
import {
  haltIsGlobal,
  isGlobalHalt,
  type AgentContext,
  type AgentModule,
  type AgentState,
  type Breakers,
} from './types';

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
  return {
    get<T>(key: string, fallback: T): T {
      return base.get(managedAccountStateKey(account, key), fallback);
    },
    set(key: string, value: unknown): void {
      base.set(managedAccountStateKey(account, key), value);
    },
  };
}

/**
 * The registry is swept in bounded batches. Run enough batches inside one
 * module cadence that even a full registry is revisited as often as the
 * strategy declares, while a small registry keeps the module's normal rate.
 */
export function managedStrategySweepIntervalMs(
  tickIntervalMs: number,
  managedEntries: number,
  batchSize = MAX_MANAGED_ENTRIES_PER_SWEEP,
): number {
  const safeTick = Number.isFinite(tickIntervalMs) && tickIntervalMs > 0
    ? Math.trunc(tickIntervalMs)
    : 1_000;
  const safeEntries = Number.isFinite(managedEntries) && managedEntries > 0
    ? Math.max(1, Math.min(MAX_MANAGED_ENTRIES_PER_AGENT, Math.trunc(managedEntries)))
    : 1;
  const safeBatch = Number.isFinite(batchSize) && batchSize > 0
    ? Math.trunc(batchSize)
    : 1;
  const rounds = Math.ceil(safeEntries / safeBatch);
  return Math.max(1_000, Math.floor(safeTick / rounds));
}

/** Keep sweep starts on the declared cadence instead of adding RPC duration. */
export function managedStrategyNextDelayMs(
  tickIntervalMs: number,
  managedEntries: number,
  elapsedMs: number,
  batchSize = MAX_MANAGED_ENTRIES_PER_SWEEP,
): number {
  const intervalMs = managedStrategySweepIntervalMs(tickIntervalMs, managedEntries, batchSize);
  const safeElapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.trunc(elapsedMs) : 0;
  return Math.max(0, intervalMs - safeElapsed);
}

interface PendingRelayWrite {
  callsId: Hex;
  to: Hex;
  data: Hex;
  functionName: string;
  submittedAt: number;
  status: 'submitted' | 'confirmed';
  transactionHash?: Hex;
}

export interface ManagedRelayStatus {
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  transactionHash?: Hex;
}

export type ManagedRelayStatusReader = (input: {
  callsId: Hex;
  chainId: number;
}) => Promise<ManagedRelayStatus>;

const PENDING_RELAY_WRITE_KEY = 'pendingRelayWrite';
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Read an already-submitted Altana bundle without ever submitting a new one. */
export const readManagedRelayStatus: ManagedRelayStatusReader = async ({ callsId, chainId }) => {
  const relay = chainId === 97 ? TESTNET_RELAY_URL : RELAY_URL;
  const response = await fetch(relay, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'wallet_getCallsStatus',
      params: [callsId],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`relay status request failed (${response.status})`);
  const body = await response.json() as {
    error?: unknown;
    result?: {
      status?: number | string;
      receipts?: { transactionHash?: unknown }[];
    };
  };
  if (body.error || !body.result) throw new Error('relay status response was invalid');
  const status = body.result.status;
  const receipt = body.result.receipts?.[0];
  const transactionHash = receipt?.transactionHash;
  if (status === 500 || status === 'FAILED') return { status: 'FAILED' };
  if ((status === 200 || status === 'CONFIRMED') && (receipt as { status?: unknown } | undefined)?.status === '0x0') {
    return { status: 'FAILED' };
  }
  if (
    (status === 200 || status === 'CONFIRMED')
    && typeof transactionHash === 'string'
    && HASH_RE.test(transactionHash)
  ) {
    return { status: 'CONFIRMED', transactionHash: transactionHash as Hex };
  }
  return { status: 'PENDING' };
};

async function reconcilePendingWrite(
  state: AgentState,
  chainId: number,
  readStatus: ManagedRelayStatusReader,
): Promise<PendingRelayWrite | null> {
  const pending = state.get<PendingRelayWrite | null>(PENDING_RELAY_WRITE_KEY, null);
  if (!pending) return null;
  if (pending.status === 'confirmed' && pending.transactionHash) return pending;

  let result: ManagedRelayStatus;
  try {
    result = await readStatus({ callsId: pending.callsId, chainId });
  } catch (cause) {
    throw new Error(
      `${pending.functionName} relay status is unavailable; refusing to resubmit an unresolved write: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (result.status === 'PENDING') {
    throw new Error(`${pending.functionName} is still pending at the relay; refusing to submit it twice`);
  }
  if (result.status === 'FAILED') {
    state.set(PENDING_RELAY_WRITE_KEY, null);
    throw new Error(`${pending.functionName} failed at the relay`);
  }
  if (!result.transactionHash) {
    throw new Error(`${pending.functionName} confirmed without a transaction receipt; refusing to resubmit`);
  }
  const confirmed: PendingRelayWrite = {
    ...pending,
    status: 'confirmed',
    transactionHash: result.transactionHash,
  };
  state.set(PENDING_RELAY_WRITE_KEY, confirmed);
  return confirmed;
}

function managedBreakers(
  state: AgentState,
  baseBreakers: Breakers,
  log: AgentContext['log'],
): Breakers {
  return {
    halt(reason, scope) {
      if (haltIsGlobal(reason, scope)) {
        baseBreakers.halt(reason, { global: true });
        log({ event: 'managed-global-halt', reason });
        return;
      }
      state.set('halted', { reason, at: new Date().toISOString(), global: false });
      log({ event: 'managed-account-halt', reason, global: false });
    },
    isHalted() {
      const baseHalt = baseBreakers.isHalted();
      if (isGlobalHalt(baseHalt)) return baseHalt;
      const halted = state.get<{ reason: string; global?: boolean } | null>('halted', null);
      return halted ? { halted: true, reason: halted.reason, global: false } : { halted: false };
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
function sessionWallet(
  client: Client,
  session: Session,
  chainId: number,
  state: AgentState,
  readStatus: ManagedRelayStatusReader,
): WalletClient {
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
      const previous = await reconcilePendingWrite(state, chainId, readStatus);
      if (previous) {
        const sameOperation = previous.to.toLowerCase() === args.address.toLowerCase()
          && previous.data.toLowerCase() === data.toLowerCase();
        state.set(PENDING_RELAY_WRITE_KEY, null);
        // Resume the exact module step that timed out. Returning the original
        // receipt lets post-write bookkeeping (notably Ranger's minted NFT id)
        // complete without broadcasting the operation a second time.
        if (sameOperation) return previous.transactionHash!;
      }
      const result = await client.execute({
        session,
        chainId,
        calls: [{ to: args.address, data }],
        // Return as soon as the relay has accepted the bundle. The calls id is
        // the durable idempotency boundary; waiting here creates a multi-minute
        // crash window in which a submitted write has not reached disk.
        noWait: true,
      });
      const submitted: PendingRelayWrite = {
        callsId: result.callsId,
        to: args.address,
        data,
        functionName: args.functionName,
        submittedAt: Date.now(),
        status: result.status === 'CONFIRMED' && result.transactionHash ? 'confirmed' : 'submitted',
        ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
      };
      state.set(PENDING_RELAY_WRITE_KEY, submitted);
      if (result.status === 'FAILED') {
        state.set(PENDING_RELAY_WRITE_KEY, null);
        throw new Error(`${args.functionName} failed at the relay`);
      }
      if (submitted.status === 'confirmed') return submitted.transactionHash!;

      // Poll only after the calls id is durable. A pending or unavailable
      // relay leaves the record in place and the next sweep reconciles it.
      const confirmed = await reconcilePendingWrite(state, chainId, readStatus);
      return confirmed!.transactionHash!;
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
  relayStatus?: ManagedRelayStatusReader;
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
    walletClient: sessionWallet(
      client,
      session,
      entry.chainId,
      state,
      opts.relayStatus ?? readManagedRelayStatus,
    ),
    log,
    state,
    breakers: managedBreakers(state, base.breakers, log),
  };
}

export async function tickManagedStrategy(opts: {
  ctx: AgentContext;
  module: AgentModule;
  client: Client;
  managerKey: ManagerKey;
  relayStatus?: ManagedRelayStatusReader;
}): Promise<{ serviced: number; errors: number }> {
  if (isGlobalHalt(opts.ctx.breakers.isHalted())) return { serviced: 0, errors: 0 };
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
          relayStatus: opts.relayStatus,
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
        // A relay timeout is not a failed transaction. Resolve the durable
        // calls id before the module can attempt any later action.
        const pending = await reconcilePendingWrite(
          managedCtx.state,
          entry.chainId,
          opts.relayStatus ?? readManagedRelayStatus,
        );
        if (pending?.status === 'confirmed' && pending.transactionHash) {
          const repaired = await opts.module.recoverConfirmedWrite?.(managedCtx, {
            to: pending.to,
            data: pending.data,
            functionName: pending.functionName,
            transactionHash: pending.transactionHash,
          });
          if (repaired) managedCtx.state.set(PENDING_RELAY_WRITE_KEY, null);
        }
        await opts.module.tick(managedCtx);
        const reconciled = managedCtx.state.get<PendingRelayWrite | null>(
          PENDING_RELAY_WRITE_KEY,
          null,
        );
        // If confirmed chain state made the module decide no write was needed,
        // the old bundle has still been reconciled and no replay is necessary.
        if (reconciled?.status === 'confirmed') {
          managedCtx.state.set(PENDING_RELAY_WRITE_KEY, null);
        }
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
