import type { AgentDetail } from '@agripinaa/agent-index';

import { isVerified } from './verified';

/**
 * Hiring an agent moves real money, so the activate path is offered only where
 * something will actually act: our own agents, or a third-party agent whose
 * endpoint answered a liveness probe. Every other listing is an on-chain
 * registration we index, and walking someone through a passkey wallet plus a
 * deposit for one of those is a dead end.
 */
export function isActivatable(input: { tokenId: string; endpointLive: boolean }): boolean {
  return isVerified(input.tokenId) || input.endpointLive;
}

/**
 * Whether this agent's own endpoint answered a liveness probe. The probe
 * itself lands with lib/liveness.ts; until then nothing third-party counts as
 * live, which fails in the safe direction: activation is withheld rather than
 * offered for an agent that cannot act. Both the detail page and the activate
 * gate resolve liveness here, so wiring the probe in is a one-place change.
 */
export async function endpointIsLive(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the probe reads the agent record; kept so wiring it in touches this body only
  agent: AgentDetail,
): Promise<boolean> {
  return false;
}

export const ACTIVATION_BLOCKED_COPY =
  'This agent is an on-chain registration we index, not one we run. Nobody has claimed it and no endpoint answered our probe, so activating it would grant a session to something that cannot act. You can still inspect its identity, owner, and feedback on-chain.';
