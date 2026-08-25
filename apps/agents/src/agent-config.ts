/**
 * Everything apps/agents needs to know about WHICH agents exist, derived from
 * the shared registry rather than restated per script.
 *
 * runner.ts, fund.ts and register.ts each used to carry their own list of agent
 * names, and nothing cross-checked them: a new agent missing from one list
 * ticked but was never funded, or was funded but never registered, with no
 * error anywhere. They all read from here now, and the two operations that
 * cannot be undone get a guard:
 *
 * - `assertModulesRegistered` refuses to boot a strategy module the registry
 *   does not know, because such a module has no token id, no manifest, and no
 *   proof-feed identity, so it would trade invisibly.
 * - `preflightManifests` refuses to register when the manifest URL about to be
 *   minted does not already serve that agent. `register(agentURI)` mints a
 *   permanent tokenURI; a 404 at mint time cannot be corrected afterwards.
 *
 * These live outside runner.ts/register.ts so tests can exercise them without
 * importing a module whose top level starts a server or signs a transaction.
 */
import { basename } from 'node:path';

import { AGENT_LIST, agentBySlug, type AgentRecord } from '@agripinaa/shared';

import { managerKeyFile } from './manager-key';

/** Where the manifests an ERC-8004 tokenURI points at are served from. */
export const MANIFEST_BASE = 'https://agripinaa.vercel.app/manifests';

/** Agents that can manage user funds (grant a scoped session to their manager key). */
export const MANAGED_AGENT_SLUGS: string[] = AGENT_LIST.filter((agent) => agent.managed).map(
  (agent) => agent.slug,
);

/**
 * Boot guard: every strategy module the runner hosts must have a registry
 * record. Fail loudly here rather than ticking an agent that has no identity.
 */
export function assertModulesRegistered(modules: readonly { name: string }[]): void {
  for (const module of modules) {
    if (!agentBySlug(module.name)) {
      throw new Error(`agent module "${module.name}" has no record in @agripinaa/shared agents.ts`);
    }
  }
}

/**
 * True when this agent exists as configuration only: the registry has no wallet
 * address for it, and `fund --gen` has not created its key file either.
 *
 * A record can legitimately be added before its wallet exists (the address is
 * not knowable until the key is generated), and the runner must not treat that
 * as a fatal misconfiguration: buildContext throws on a missing key file, and
 * one unprovisioned agent would otherwise take every other agent's tick loop
 * down with it at boot. A record that DOES carry a wallet address but has no
 * key file is a different thing entirely, a provisioned agent whose secret is
 * missing, and that must still fail loudly.
 */
export function isUnprovisioned(
  record: Pick<AgentRecord, 'wallet'>,
  walletFileExists: boolean,
): boolean {
  return record.wallet === null && !walletFileExists;
}

/**
 * One wallet's share of the funding transfer, in whole units.
 *
 * Every ERC20 field here has to be listed in fund.ts's transfer loop as well.
 * A leg that exists in the plan but not in that loop is budgeted, printed by
 * `--plan`, and then never sent, which looks like a funded agent right up until
 * its first trade blocks on an empty balance.
 */
export interface FundingEntry {
  /** wallets/<name>.json, which is what `--only` selects on. */
  name: string;
  bnb: string;
  usdt: string;
  wbnb: string;
  usdc: string;
  btcb: string;
  /**
   * Companion manager session key to generate alongside this wallet, or null.
   * It needs no funding of its own (the user's account pays gas).
   */
  sessionKey: string | null;
}

/**
 * The split of the real budget: one entry per agent from the registry, plus the
 * non-agent wallets that have no registry record of their own. Native gas per
 * agent covers registration, approvals, and protocol calls.
 */
export const FUNDING_PLAN: FundingEntry[] = [
  ...AGENT_LIST.map((agent) => ({
    // The registry stores the file name; `--only` and wallets/ key on the stem.
    name: basename(agent.walletFile, '.json'),
    bnb: agent.funding.bnb,
    usdt: agent.funding.usdt ?? '0',
    wbnb: agent.funding.wbnb ?? '0',
    usdc: agent.funding.usdc ?? '0',
    btcb: agent.funding.btcb ?? '0',
    // Derived from managerKeyFile so fund --gen writes exactly the file the
    // runner later loads; a mismatch disables managed mode silently.
    sessionKey: agent.managed ? basename(managerKeyFile(agent.slug), '.json') : null,
  })),
  {
    name: 'facilitator',
    bnb: '0.0008',
    usdt: '0',
    wbnb: '0',
    usdc: '0',
    btcb: '0',
    sessionKey: null,
  },
];

/**
 * Narrow the plan to the wallets named by `--only`.
 *
 * Funding is the one operation here that is not idempotent: registration and
 * attestation both skip what is already done, but a second transfer just sends
 * the money again. Adding a fifth agent must therefore be able to fund only
 * that agent, and an unrecognised name has to fail rather than quietly fund
 * nothing (or, worse, everything).
 */
export function selectFundingEntries(only: string | undefined): FundingEntry[] {
  if (only === undefined) return FUNDING_PLAN;
  const wanted = new Set(only.split(',').map((name) => name.trim()).filter(Boolean));
  if (wanted.size === 0) throw new Error('--only needs a comma-separated list of wallet names');
  const known = new Set(FUNDING_PLAN.map((entry) => entry.name));
  const unknown = [...wanted].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `--only names an unknown wallet: ${unknown.join(', ')} (known: ${[...known].join(', ')})`,
    );
  }
  return FUNDING_PLAN.filter((entry) => wanted.has(entry.name));
}

/** The exact URI `register(agentURI)` mints for this agent. */
export function manifestUrl(record: AgentRecord): string {
  return `${MANIFEST_BASE}/${record.slug}.json`;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Confirm the manifest this agent is about to be minted against already serves
 * that agent. Checks the identity carried in the body, not just a 200, so a
 * catch-all route or a stale deploy of a different agent is caught too.
 */
export async function preflightManifest(
  record: AgentRecord,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const url = manifestUrl(record);
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(
      `manifest ${url} is unreachable (${err instanceof Error ? err.message : String(err)}); deploy it before registering`,
    );
  }
  if (!res.ok) {
    throw new Error(`manifest ${url} responded ${res.status}; deploy it before registering`);
  }
  let body: { name?: unknown };
  try {
    body = (await res.json()) as { name?: unknown };
  } catch {
    throw new Error(`manifest ${url} did not parse as JSON; deploy it before registering`);
  }
  if (body.name !== record.name) {
    throw new Error(`manifest ${url} says name="${String(body.name)}", expected "${record.name}"`);
  }
}

/**
 * Preflight the whole batch before signing anything. One bad manifest aborts
 * the run: a partially registered batch is fine to retry, but an identity
 * minted against a 404 is permanent.
 */
export async function preflightManifests(
  records: readonly AgentRecord[],
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  for (const record of records) {
    await preflightManifest(record, fetchImpl);
  }
}
