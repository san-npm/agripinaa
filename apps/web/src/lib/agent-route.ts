import 'server-only';

import type { AgentDetail } from '@agripinaa/agent-index';
import { AGENT_LIST } from '@agripinaa/shared/agents';
import { notFound } from 'next/navigation';

import { CHAIN_ID, getAgent } from './data';

/**
 * The agent behind /agent/[chainId]/[tokenId] and its children, resolved where
 * a 404 can still become the response status.
 *
 * Each of those pages used to call `notFound()` inside its own Suspense
 * boundary, which runs after the shell has already streamed as a 200. An
 * unknown id therefore answered 200 with a not-found body: a soft 404 on the
 * routes the sitemap points at, which a link checker reads as a live agent.
 * Called from `generateMetadata` and from the page body above its boundary,
 * this commits the status before anything flushes. Same shape as
 * c/[category]/page.tsx, which was measured to give a hard 404.
 *
 * An indexer outage deliberately does not 404. A read that threw says nothing
 * about whether the agent exists, and answering 404 would tell a crawler that
 * a live agent is gone; only a definitive null does that. So the two failures
 * are kept apart: `null` is the registry saying there is no such agent, and
 * `undefined` is the read failing, which the page renders as its degraded
 * state exactly as before.
 */
export async function resolveAgentRoute(
  params: Promise<{ chainId: string; tokenId: string }>,
): Promise<AgentDetail | undefined> {
  const { chainId, tokenId } = await params;
  if (Number.parseInt(chainId, 10) !== CHAIN_ID) notFound();
  const agent = await getAgent(tokenId).catch(() => undefined);
  if (agent === null) notFound();
  return agent;
}

/**
 * The params these routes prerender, which is what lets the 404 above reach
 * the response status. Under cacheComponents a dynamic route with no `generateStaticParams`
 * answers every request from a param-independent shell, streamed as a 200
 * before the page runs, so nothing the page decides can change the status.
 * A route that declares its params does not, and an id outside the list is
 * rendered on demand with the status still open (measured: with this, an
 * unknown id answers 404; without it, 200 with a not-found body).
 *
 * The list is the registered first-party agents, read from the registry rather
 * than from the index: no network at build, it is the set every judge opens,
 * and cacheComponents refuses an empty one. Third-party ids are not
 * enumerable, and they do not need to be: they render on demand, which is the
 * path this exists to keep correct.
 */
export function registeredAgentParams(): { chainId: string; tokenId: string }[] {
  return AGENT_LIST.filter((agent) => agent.tokenId != null).map((agent) => ({
    chainId: String(CHAIN_ID),
    tokenId: agent.tokenId as string,
  }));
}
