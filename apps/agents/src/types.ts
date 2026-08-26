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
  halt(reason: string): void;
  isHalted(): { halted: boolean; reason?: string };
  /** Sliding-window action counter; returns false when the cap is reached. */
  allowAction(kind: string, maxPerDay: number): boolean;
  /** Release the newest reservation when an attempted action definitively failed. */
  releaseAction?(kind: string): void;
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
}
