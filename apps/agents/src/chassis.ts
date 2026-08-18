import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReputationClient } from '@agripinaa/exec-metrics';
import { BSC_MAINNET } from '@agripinaa/shared';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import type { AgentContext, AgentState, Breakers } from './types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const WALLETS_DIR = join(ROOT, '..', '..', 'wallets');

interface DiskState {
  halted?: { reason: string; at: string };
  actions?: Record<string, number[]>;
  kv?: Record<string, unknown>;
}

function stateFile(name: string): string {
  return join(DATA_DIR, `${name}.state.json`);
}

function loadDisk(name: string): DiskState {
  try {
    return JSON.parse(readFileSync(stateFile(name), 'utf8')) as DiskState;
  } catch {
    return {};
  }
}

function saveDisk(name: string, state: DiskState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(stateFile(name), JSON.stringify(state, null, 2));
}

export function loadAgentAccount(name: string): Account {
  const file = join(WALLETS_DIR, `agent-${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`missing wallet file ${file}; run: pnpm --filter @agripinaa/agents fund -- --gen ${name}`);
  }
  const { privateKey } = JSON.parse(readFileSync(file, 'utf8')) as {
    privateKey: `0x${string}`;
  };
  return privateKeyToAccount(privateKey);
}

/**
 * Build the runtime context for one agent: BSC clients, JSONL logger,
 * durable state, and breakers. Enrollment with the rebate indexer is
 * asserted BEFORE the agent may trade (the indexer is owner-scoped and
 * never backfills orders from before enrollment).
 */
export async function buildContext(name: string): Promise<AgentContext> {
  const account = loadAgentAccount(name);
  const transport = fallback(BSC_MAINNET.rpcUrls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain: bsc, transport });
  const walletClient = createWalletClient({ account, chain: bsc, transport });

  mkdirSync(DATA_DIR, { recursive: true });
  const logPath = join(DATA_DIR, `${name}.log.jsonl`);
  const log = (event: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), agent: name, ...event });
    appendFileSync(logPath, line + '\n');
    console.log(line);
  };

  const disk = loadDisk(name);

  const state: AgentState = {
    get<T>(key: string, fallbackValue: T): T {
      const kv = disk.kv ?? {};
      return (key in kv ? kv[key] : fallbackValue) as T;
    },
    set(key: string, value: unknown): void {
      disk.kv = { ...(disk.kv ?? {}), [key]: value };
      saveDisk(name, disk);
    },
  };

  const breakers: Breakers = {
    halt(reason: string): void {
      disk.halted = { reason, at: new Date().toISOString() };
      saveDisk(name, disk);
      log({ event: 'halt', reason });
    },
    isHalted() {
      return disk.halted
        ? { halted: true, reason: disk.halted.reason }
        : { halted: false };
    },
    allowAction(kind: string, maxPerDay: number): boolean {
      const now = Date.now();
      const dayAgo = now - 24 * 3600 * 1000;
      const actions = disk.actions ?? {};
      const recent = (actions[kind] ?? []).filter((t) => t > dayAgo);
      if (recent.length >= maxPerDay) return false;
      actions[kind] = [...recent, now];
      disk.actions = actions;
      saveDisk(name, disk);
      return true;
    },
  };

  // Enrollment gate: refuse to construct a tradeable context if the wallet
  // could trade unindexed. A 5xx from the service halts startup rather than
  // silently producing invisible history.
  const reputation = new ReputationClient();
  const enrollment = await reputation.enrollAndGetTier(account.address);
  if (!enrollment.ok) {
    throw new Error(
      `rebate-indexer enrollment failed for ${name} (${account.address}): ` +
        `${enrollment.error}; refusing to start (history would never index)`,
    );
  }
  log({ event: 'enrolled', wallet: account.address });

  return {
    name,
    chainId: 56,
    account,
    publicClient,
    walletClient,
    log,
    state,
    breakers,
  };
}
