import type { AgentDetail } from '@agripinaa/agent-index';
import { agentByTokenId } from '@agripinaa/shared/agents';

import { countsAsLive, getLiveness } from './liveness';

/**
 * Whether anything on our side will read a session granted to this agent.
 *
 * The registry's `managed` flag is the only thing that answers that. A managed
 * agent's runner loads granted mandates and signs router calls with its manager
 * key; every other agent ticks on its own capital and never looks at the
 * session store (nothing under apps/agents/src reads it). So `managed: false`
 * means a grant would sit unread for its whole expiry window.
 */
export function agentConsumesSession(tokenId: string): boolean {
  return agentByTokenId(tokenId)?.managed ?? false;
}

export interface ActivationInput {
  tokenId: string;
  /** Whether this agent's own endpoint answered a liveness probe. */
  endpointLive: boolean;
  /** Whether a runner consumes the grant. Derive it with `agentConsumesSession`. */
  consumesSession: boolean;
}

/**
 * Activation moves live funds and asks for a passkey account, gas, and a signed
 * grant, so it is offered only where something will consume that grant: an
 * agent with a managed path of ours, or a third-party agent whose own endpoint
 * answered a liveness probe.
 *
 * Ownership deliberately does NOT appear here. Asking "is this one of ours?"
 * passes all four first-party agents, three of which run on their own capital
 * and read no session at all, so that question sent visitors through the whole
 * wallet flow for a key nothing would ever pick up. The question that matters
 * is whether the grant gets consumed.
 */
export function isActivatable(input: ActivationInput): boolean {
  return input.consumesSession || input.endpointLive;
}

/** Why activation is withheld, or null when it is offered. */
export type ActivationBlockedReason = 'own-capital-only' | 'no-live-endpoint';

/**
 * Both blocked branches fail closed for the same reason (no consumer for the
 * grant) but they are different situations, so they get different copy: one of
 * ours running unmanaged is a scope statement, an indexed registry row with no
 * answering endpoint is a dead end.
 */
export function activationBlockedReason(input: ActivationInput): ActivationBlockedReason | null {
  if (isActivatable(input)) return null;
  return agentByTokenId(input.tokenId) ? 'own-capital-only' : 'no-live-endpoint';
}

export interface ActivationBlockedCopy {
  /** Page heading, readable without the agent name in front of it. */
  headline: string;
  /** Says exactly what was checked, and nothing that was not. */
  body: string;
  /** What the visitor can do here instead. */
  ctaLabel: string;
}

/**
 * Copy per reason, held to what `isActivatable` and `activationBlockedReason`
 * actually evaluate. The single constant this replaced asserted "Nobody has
 * claimed it and no endpoint answered our probe" on every blocked agent: the
 * claim half was never evaluated by anything here, and the endpoint half was
 * being told to visitors of our own agents, whose endpoints are up.
 */
export const ACTIVATION_BLOCKED_COPY: Record<ActivationBlockedReason, ActivationBlockedCopy> = {
  'own-capital-only': {
    headline: 'Runs on its own capital',
    body: 'This is one of our agents and it runs on its own capital on BNB Smart Chain. It does not take deposits under management yet, so no runner would pick up a session key granted here. Its execution record, its x402 status endpoint, and its rows in the proof feed are all open to inspect in the meantime.',
    ctaLabel: 'See its execution record',
  },
  'no-live-endpoint': {
    headline: 'Nothing to activate here',
    body: 'This agent is an on-chain registration we index, not one we run, and no endpoint of its own answered our liveness probe. A session granted here would have nothing behind it to act on. You can still inspect its identity, owner, and on-chain feedback.',
    ctaLabel: 'Inspect on-chain identity',
  },
};

/**
 * Whether this agent's own endpoint answered a liveness probe. Both the detail
 * page and the activate gate resolve liveness here, so there is one answer per
 * agent whichever way a visitor arrives.
 *
 * Read only, never a probe: probing on a render would put an unrelated host in
 * front of every page load, and it would let anyone aim this site's fetches by
 * reloading a page. The probe runs when a claim is saved and from the re-probe
 * cron; here a result that nobody refreshed inside the window decays to false,
 * which fails in the safe direction (activation withheld, not offered).
 *
 * A first-party agent is not resolved this way at all. Its runner is ours, and
 * what decides whether a granted session gets consumed is the registry's
 * `managed` flag, which `agentConsumesSession` already answers.
 */
export async function endpointIsLive(agent: AgentDetail): Promise<boolean> {
  if (agentByTokenId(agent.tokenId)) return false;
  const endpoint = agent.endpoint?.trim();
  if (!endpoint) return false;
  const record = await getLiveness(agent.chainId, agent.tokenId).catch(() => null);
  return countsAsLive(record, endpoint);
}
