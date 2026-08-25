/**
 * Rotation policy for the managed-yield agents.
 *
 * The router is per-token, un-owned, and agent-agnostic: it hardcodes every
 * recipient to the calling account, so any number of agents can drive it and
 * none of them can divert funds. That makes "who manages my deposit" an actual
 * choice rather than a single product feature, and what a depositor is actually
 * choosing between is a policy: how big an edge is worth moving for, how many
 * checks it has to survive, and how often a move may happen at all.
 *
 * This file holds those policies. It lives outside src/agents because a file
 * there must export exactly one AgentModule (tests/registry.test.ts), and
 * because both `yield` and `yield-b` read from it: the two must not each carry
 * their own copy of what "conservative" means.
 */
import {
  DEFAULT_MANAGED_POLICY,
  type ManagedPolicy,
  type RotationDecision,
  type RotationInput,
} from './agents/yield';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The numbers one agent's rotation gate enforces, in the units it publishes. */
export interface RotationParams {
  /** The rival venue must beat the current one by at least this, in bps. */
  thresholdBps: number;
  /** Consecutive checks that edge must survive before anything moves. */
  requiredWins: number;
  /** Shortest gap between two rotations of the same mandate. */
  minRotationIntervalMs: number;
  /** How often the agent looks. */
  tickIntervalMs: number;
}

/**
 * yield-b: the patient one.
 *
 * Every number is deliberately looser than the incumbent's (50 bps, two
 * confirmations, six-hourly). 120 bps is roughly half the whole spread these
 * two venues have shown between them, so it only moves for a lead that is
 * material rather than a lead that is measurable. Three confirmations across a
 * twelve hour tick means an edge has to hold for a day and a half before it
 * counts, and the two-day floor means a mandate cannot be walked back and forth
 * even if it does.
 *
 * Every rotation is a cost (gas, and the yield lost while the position is
 * neither here nor there), so the question a depositor is answering by picking
 * this agent is whether they would rather capture small edges quickly or pay
 * for fewer moves.
 */
export const YIELD_B_PARAMS: RotationParams = {
  thresholdBps: 120,
  requiredWins: 3,
  minRotationIntervalMs: 2 * DAY_MS,
  tickIntervalMs: 12 * HOUR_MS,
};

/**
 * The rotation gate, stated as one predicate over the two live rates and the
 * confirmation count. Both of yield-b's paths (its own capital and every
 * managed mandate) run through this, so the agent cannot hold to one standard
 * with its own money and another with a depositor's.
 */
export function shouldRotate(input: {
  currentApyBps: number;
  rivalApyBps: number;
  thresholdBps: number;
  consecutiveWins: number;
  requiredWins: number;
}): boolean {
  return (
    input.rivalApyBps - input.currentApyBps >= input.thresholdBps &&
    input.consecutiveWins >= input.requiredWins
  );
}

/**
 * The confirmation streak around `shouldRotate`: arm on a qualifying check,
 * reset the moment one does not qualify, act when the count is reached. The
 * reset is the part that matters, since without it a spike that qualified once
 * a month would accumulate toward a rotation over a year of calm.
 */
export function conservativeRotation(
  input: RotationInput,
  params: RotationParams = YIELD_B_PARAMS,
): RotationDecision {
  const other: 'venus' | 'aave' = input.venue === 'venus' ? 'aave' : 'venus';
  const currentApyBps = input.venue === 'venus' ? input.venusBps : input.aaveBps;
  const rivalApyBps = other === 'venus' ? input.venusBps : input.aaveBps;
  const edgeBps = rivalApyBps - currentApyBps;
  const nextStreak = edgeBps >= params.thresholdBps ? input.betterStreak + 1 : 0;
  const rotate = shouldRotate({
    currentApyBps,
    rivalApyBps,
    thresholdBps: params.thresholdBps,
    consecutiveWins: nextStreak,
    requiredWins: params.requiredWins,
  });
  return rotate
    ? { action: 'rotate', target: other, edgeBps, nextStreak: 0 }
    : { action: 'hold', target: input.venue, edgeBps, nextStreak };
}

export const YIELD_B_POLICY: ManagedPolicy = {
  decide: (input) => conservativeRotation(input),
  minRotationIntervalMs: YIELD_B_PARAMS.minRotationIntervalMs,
  maxRotationsPerDay: 1,
};

/**
 * Which policy each managed agent runs on a user's mandate.
 *
 * Keyed by slug rather than defaulted, on purpose. A managed agent with no
 * entry here is not serviced at all: the runner logs it and leaves the deposit
 * where it is. Falling back to another agent's policy would mean a depositor
 * who chose the patient agent silently getting the busy one, which is exactly
 * the thing having two agents is supposed to make visible.
 */
const MANAGED_POLICIES: Record<string, ManagedPolicy> = {
  yield: DEFAULT_MANAGED_POLICY,
  'yield-b': YIELD_B_POLICY,
};

export function policyForAgent(agent: string): ManagedPolicy | undefined {
  return MANAGED_POLICIES[agent];
}
