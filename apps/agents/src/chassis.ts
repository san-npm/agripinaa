import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Owner-only, matching the wallet files these sit beside on the VM. State
 * carries halt flags and rate-limit ledgers, logs carry every action taken;
 * neither is key material, but nothing else on the host needs to read them.
 */
const DATA_DIR_MODE = 0o700;
const DATA_FILE_MODE = 0o600;

/** Create the data dir owner-only; an existing dir is left as it is. */
export function ensureDataDir(dir: string = DATA_DIR): void {
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
}

/**
 * Atomic: write to a temp file then rename, so a crash mid-write cannot
 * leave a truncated state file that reads as "not halted, caps reset". The
 * mode passed to writeFileSync applies only when it creates the file, and a
 * crash between write and rename leaves the temp file behind at whatever mode
 * it had, so the mode is set outright before the rename carries it over.
 */
export function writeStateFile(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, { mode: DATA_FILE_MODE });
  chmodSync(tmp, DATA_FILE_MODE);
  renameSync(tmp, file);
}

/** Append one JSONL line, creating the log owner-only on first write. */
export function appendLogLine(file: string, line: string): void {
  appendFileSync(file, line + '\n', { mode: DATA_FILE_MODE });
}

interface DiskState {
  halted?: { reason: string; at: string };
  actions?: Record<string, number[]>;
  kv?: Record<string, unknown>;
}

function stateFile(name: string): string {
  return join(DATA_DIR, `${name}.state.json`);
}

function loadDisk(name: string): DiskState {
  const file = stateFile(name);
  if (!existsSync(file)) return {}; // first run
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DiskState;
  } catch {
    // Fail CLOSED: a corrupt/truncated state file (e.g. crash mid-write)
    // must not silently reset halts and rate limits. Preserve it for a
    // human and boot in a halted state so the agent monitors but never
    // trades until the flag is cleared.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort preservation */
    }
    return { halted: { reason: 'state-file-corrupt', at: new Date().toISOString() } };
  }
}

function saveDisk(name: string, state: DiskState): void {
  ensureDataDir();
  writeStateFile(stateFile(name), JSON.stringify(state, null, 2));
}

/** Where an agent's own-capital key lives. Matches the registry's walletFile. */
export function agentWalletPath(name: string): string {
  return join(WALLETS_DIR, `agent-${name}.json`);
}

/** Whether the key exists yet. An agent can be configured before it is. */
export function hasAgentWallet(name: string): boolean {
  return existsSync(agentWalletPath(name));
}

export function loadAgentAccount(name: string): Account {
  const file = agentWalletPath(name);
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

  ensureDataDir();
  const logPath = join(DATA_DIR, `${name}.log.jsonl`);
  const log = (event: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), agent: name, ...event });
    appendLogLine(logPath, line);
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

  // Enrollment with the rebate indexer is best-effort: marketplace execution
  // metrics read the CoW orderbook directly, so a down indexer (observed 530
  // since 2026-08-08) must not block trading. Orders placed before a
  // successful enrollment forfeit rebate/XP indexing only; retried each boot
  // until it lands.
  const reputation = new ReputationClient();
  const enrollment = await reputation.enrollAndGetTier(account.address);
  if (enrollment.ok) {
    log({ event: 'enrolled', wallet: account.address });
  } else {
    log({
      event: 'enrollment-unavailable',
      wallet: account.address,
      error: enrollment.error,
      consequence: 'rebate/XP indexing deferred; execution metrics unaffected',
    });
  }

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
