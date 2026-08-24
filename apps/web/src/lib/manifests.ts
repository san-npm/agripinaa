/**
 * Agent manifest bodies, served by /manifests/<slug>.json.
 *
 * These were four static files under public/manifests, then a hardcoded copy
 * here, and are now read straight off the shared agent registry. The on-chain
 * ERC-8004 tokenURIs point at those exact paths and are permanent, so the paths
 * and the bodies must stay as they were; the only value that changes is
 * x402.endpoint, which is injected per request from the runner resolver instead
 * of being frozen into a committed file at tunnel-rotation time.
 *
 * Byte parity now rests on the registry: `AgentRecord.manifest` declares its
 * keys in the order the original JSON did, and packages/shared/tests pins the
 * exact serialized bytes of all four. Nothing here may reorder or reshape a
 * body on its way out.
 */
import { AGENT_LIST } from '@agripinaa/shared/agents';
import type { ManifestBase } from '@agripinaa/shared/agents';

export type { ManifestExecution, ManifestBase, SafetyValue } from '@agripinaa/shared/agents';

/** A registry manifest with the live runner endpoint filled in. */
export interface Manifest extends ManifestBase {
  x402: { endpoint: string; priceUsdt: string; note: string };
}

const BASE: Record<string, ManifestBase> = Object.fromEntries(
  AGENT_LIST.map((agent) => [agent.slug, agent.manifest]),
);

export const MANIFEST_SLUGS: string[] = AGENT_LIST.map((agent) => agent.slug);

export function buildManifest(slug: string, runnerBase: string): Manifest | null {
  const base = BASE[slug];
  if (!base) return null;
  return {
    ...base,
    // `endpoint` first, then the rest, so the x402 key order matches the
    // original files.
    x402: { endpoint: new URL(`/${slug}/status`, runnerBase).toString(), ...base.x402 },
  };
}
