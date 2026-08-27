import type { PublicClient, WalletClient, Account } from 'viem';

export type Category = 'rebalancing' | 'grid' | 'yield' | 'health-factor';

export interface AgentLogger {
  (event: Record<string, unknown>): void;
}

/** Durable per-agent state persisted to disk between ticks and restarts. */
export interface AgentState {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface Breakers {
  /** Permanently halt this agent (until a human clears the state file). */
  halt(reason: string, scope?: { global?: boolean }): void;
  isHalted(): { halted: boolean; reason?: string; global?: boolean };
  /** Sliding-window action counter; returns false when the cap is reached. */
  allowAction(kind: string, maxPerDay: number): boolean;
  /** Release the newest reservation when an attempted action definitively failed. */
  releaseAction?(kind: string): void;
}

const ACCOUNT_SCOPED_HALT_REASONS = new Set([
  'daily-loss',
  'trend-breakout',
  'state-incomplete',
]);

/** Unexpected integrity halts fail closed globally; known portfolio-risk halts stay local. */
export function haltIsGlobal(reason: string, scope?: { global?: boolean }): boolean {
  return scope?.global ?? !ACCOUNT_SCOPED_HALT_REASONS.has(reason);
}

/** Legacy/operator halts are global; only explicit account-scoped halts are not. */
export function isGlobalHalt(status: ReturnType<Breakers['isHalted']>): boolean {
  return status.halted && status.global !== false;
}

export interface ConfirmedManagedWrite {
  to: `0x${string}`;
  data: `0x${string}`;
  functionName: string;
  transactionHash: `0x${string}`;
}

export interface AgentContext {
  name: string;
  chainId: number;
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient;
  log: AgentLogger;
  state: AgentState;
  breakers: Breakers;
}

export interface AgentModule {
  name: string;
  category: Category;
  tickIntervalMs: number;
  /** One strategy iteration. Throwing is safe: the runner logs and backs off. */
  tick(ctx: AgentContext): Promise<void>;
  /** Introspection payload served behind the x402 paywall. */
  status(ctx: AgentContext): Promise<Record<string, unknown>>;
  /** Repair module bookkeeping after a relay timeout later confirms on-chain. */
  recoverConfirmedWrite?(ctx: AgentContext, write: ConfirmedManagedWrite): Promise<boolean>;
}
