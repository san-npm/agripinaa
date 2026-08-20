import 'server-only';

import gridManifest from '../../public/manifests/grid.json';

/**
 * Base URL of the agent runner's HTTP server (behind the Cloudflare tunnel).
 * Same source of truth as the proof feed: AGENTS_BASE_URL if set, else the
 * committed manifest endpoint. The tunnel is treated as an untrusted boundary;
 * callers must validate anything read back from it.
 */
export function agentsBase(): string {
  const configured = process.env.AGENTS_BASE_URL?.trim();
  return configured || gridManifest.x402.endpoint;
}

export function agentsUrl(path: string): string {
  return new URL(path, agentsBase()).toString();
}
