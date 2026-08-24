import 'server-only';

import { runnerBase, runnerUrl } from './runner-url';

/**
 * Base URL of the agent runner's HTTP server (behind the Cloudflare tunnel).
 * Same source of truth as the proof feed. The tunnel is treated as an untrusted
 * boundary; callers must validate anything read back from it.
 */
export async function agentsBase(): Promise<string> {
  return runnerBase();
}

export async function agentsUrl(path: string): Promise<string> {
  return runnerUrl(path);
}
