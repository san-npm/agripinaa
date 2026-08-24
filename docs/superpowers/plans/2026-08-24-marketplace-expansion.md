# Agripinaa Marketplace Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Agripinaa from four house agents plus a thin read-only index into a marketplace where a judge can browse populated category hubs, compare agents, verify claims without spending money, and where third-party owners can claim and enrich their listings.

**Architecture:** A pnpm monorepo. `apps/web` (Next.js 16, App Router, `cacheComponents`) is the marketplace; `apps/agents` is one Node process hosting every agent tick loop plus an x402 status server behind a tunnel; `packages/shared` holds chain/contract/agent constants; `packages/agent-index` merges 8004scan, a committed snapshot, and direct registry reads. Work proceeds in five phases, each independently shippable: harden the judge path, build an add-agent scaffold and four new agents, add claim + data quality, add public proof surfaces, then docs.

**Tech Stack:** TypeScript, Next.js 16.3.0 (React 19.2.8, Tailwind v4), viem 2.55, node:test via tsx, pnpm 10.33.3, Node >= 22, Foundry (contracts, unchanged in this plan), Vercel (web), Aleph Cloud VM + cloudflared (agents).

**Spec:** `docs/superpowers/specs/2026-08-24-marketplace-expansion-design.md`

## Global Constraints

- **Next.js 16 is not the Next.js you know.** Before writing ANY code under `apps/web`, read the relevant guide in `node_modules/next/dist/docs/01-app/` (resolved from `apps/web`; in this monorepo the real path is `node_modules/.pnpm/next@16.3.0_*/node_modules/next/dist/docs/`). This is mandated by `apps/web/AGENTS.md`. Heed deprecation notices.
- **`use cache` + `cacheLife`**: every server data function in `apps/web/src/lib` uses the `'use cache'` directive with `cacheLife('minutes')` or `cacheLife('hours')`. Follow that existing pattern; do not introduce `unstable_cache` or `revalidate` exports.
- **Commit convention (repo established, no exceptions):** `scope: subject` in lower case (scopes in use: `web`, `agents`, `shared`, `index`, `contracts`, `ops`, `docs`, `managed`), a body explaining why, and a final `Verified: ...` line stating exactly what was run or checked. **No AI attribution, no Co-Authored-By for Claude, no "Generated with" footer.**
- **Copy rules for anything user-visible (UI text, docs, commit bodies):** never use an em dash or en dash as punctuation (use comma, period, colon, parentheses; numeric ranges take a hyphen). Never introduce veracity-claiming words as praise (honest, true, real, factual, genuine, authentic). The existing product term "verified" (meaning: carries an on-chain ERC-8004 attestation from our verifier) stays as-is; it is a technical status, not praise.
- **Never print, log, or commit private key material.** `wallets/*.json` contain `privateKey`. Read them only where existing code already does.
- **On-chain writes (registration, attestation, funding) require the owner's explicit go-ahead in the session.** No task in this plan may broadcast a transaction without it.
- **Agent display names require the owner's sign-off** before `register.ts` runs. Slugs in this plan (`grid-b`, `venus-guardian`, `weight-rebalancer`, `yield-b`) are internal identifiers and are fine to use in code.
- **Test commands:** `pnpm -r test` (all workspaces), `pnpm --filter @agripinaa/web typecheck`, `pnpm --filter @agripinaa/web build`, `pnpm --filter @agripinaa/agents test`. Node's built-in runner is used via `tsx --test tests/*.test.ts`.
- **`apps/web` tests run under the `react-server` condition** (`tsx --conditions=react-server --test tests/*.test.ts`, already wired into the web `test` script as of Task 1). Reason: `server-only` resolves to a bare `throw` under the default condition and to a no-op under `react-server`, which is how Next resolves it. Lib modules keep their `server-only` markers; the runner adapts. Settled once here, so no later task needs to revisit it: any web test importing a lib module with that marker works as long as the script keeps the flag.
- **Never commit a `.env*` file or an API key.** `SCAN8004_API_KEY` lives in Vercel env and `.env.local`.
- **`pnpm --filter @agripinaa/web lint` exits 1 at baseline.** Three pre-existing errors: `set-state-in-effect` in `dashboard/page.tsx` and `AnimatedNumber.tsx`, and an unused var in `managed.ts`. Lint is NOT a gate for any task in this plan. Do not fix unrelated lint errors as a side quest, and do not let a red lint run block a commit whose own files are clean.
- **`npx tsx` does not self-install here.** In a workspace that does not yet have `tsx` linked, `npx tsx` fails with `command not found` rather than fetching it. Use the monorepo's existing binary (`packages/shared/node_modules/.bin/tsx`) for a red-phase run that happens before the workspace's own devDependency is installed. This matters only for the first test in a workspace.
- **Baseline as of Task 1 (2026-08-24):** `pnpm -r --if-present test` is 202 passing, 0 failing (shared 7, exec-metrics 25, agent-index 4, session-kit 37, web 3, agents 126). Any task that ends with a lower total in an untouched workspace has broken something. After Tasks 2, 3, the SSRF hardening, and the lp-range fixes the total is **220 passing** (agents 135, web 12, agent-index 4, exec-metrics 25, session-kit 37, shared 7).
- **Run ONE repo-writing task at a time.** Learned the hard way on 2026-08-24: two subagents working in parallel (Task 3 and the lp-range follow-up) collided in the git index. One used a broad `git add` that swept the other's files in, the other's commit retries failed with "no changes added to commit", one reset to recover, and a retry raced into that window, so a commit ended up with the wrong task's message attached to the wrong task's files. No work was lost (the tree and the test totals reconciled), but untangling it cost more than the parallelism saved. Different directories are NOT enough isolation, because the index and HEAD are shared. If parallel execution is genuinely needed, give each agent its own git worktree.
- **Never use `git add -A`, `git add .`, or `git commit -a`.** Stage only the explicit paths the task owns. This is what turns a harmless collision into a mislabelled commit.

## File Structure

**New files (web):**
- `apps/web/src/lib/runner-url.ts` - resolves the agent runner base URL (env -> KV -> committed default) and exposes a URL validator. Single source of truth; `agents-endpoint.ts` and `proof.ts` both consume it.
- `apps/web/src/lib/kv.ts` - tiny Upstash-REST key/value client over `fetch`, no dependency, no-ops when env vars are absent.
- `apps/web/src/lib/manifests.ts` - server-side manifest content per agent slug, built from `@agripinaa/shared` agent config, runner URL injected at request time.
- `apps/web/src/app/manifests/[slug]/route.ts` - serves `/manifests/<slug>.json` dynamically (replaces the static files).
- `apps/web/src/app/api/ops/runner-url/route.ts` - bearer-authenticated POST where the VM self-reports its current tunnel URL.
- `apps/web/src/lib/claims.ts` - claim record type, KV read/write, EIP-712 payload builder and verifier.
- `apps/web/src/app/api/claim/route.ts` - POST claim (verify signature + `ownerOf`), GET claim by agent.
- `apps/web/src/app/agent/[chainId]/[tokenId]/claim/page.tsx` + `apps/web/src/components/ClaimForm.tsx` - claim UI.
- `apps/web/src/lib/liveness.ts` - endpoint liveness probe (SSRF-safe) + badge state.
- `apps/web/src/app/api/cron/refresh/route.ts` - scheduled index refresh + liveness re-probe.
- `apps/web/src/components/AgentFilters.tsx` - search/category/liveness filter controls for `/agents`.
- `apps/web/src/app/funds/page.tsx` + `apps/web/src/components/RouterPanel.tsx` - public managed-funds proof page.
- `apps/web/src/app/leaderboard/page.tsx` - execution-quality leaderboard.
- `apps/web/src/components/X402Demo.tsx` - x402 paid-status interaction on first-party agent pages.
- `apps/web/src/components/TrackRecordPanel.tsx` - cumulative fills/surplus/P&L per first-party agent.
- `apps/web/src/app/not-found.tsx`, `error.tsx`, `loading.tsx`, `robots.ts`, `sitemap.ts`, `opengraph-image.tsx`.

**New files (shared / agents):**
- `packages/shared/src/agents.ts` - THE agent registry: one record per first-party agent (slug, tokenId, name, category, wallet, manifest fields, funding plan, managed flag, proof refs). Supersedes the duplicated lists.
- `apps/agents/src/agents/grid-b.ts`, `venus-guardian.ts`, `weight-rebalancer.ts`, `yield-b.ts` - new strategy modules.
- `apps/agents/tests/grid-b.test.ts`, `venus-guardian.test.ts`, `weight-rebalancer.test.ts`, `yield-b.test.ts`.
- `apps/agents/src/harvest-proofs.ts` - reads agent JSONL logs, emits proof refs for attestation.
- `ops/report-runner-url.sh` - VM-side self-report of the tunnel URL.

**Modified files:** `apps/web/src/lib/{agents-endpoint,proof,data,verified,onchain-rep}.ts`, `apps/web/src/app/{page,agents/page,c/[category]/page}.tsx`, `apps/web/src/components/{AgentCard,ProofFeed}.tsx`, `apps/web/src/app/agent/[chainId]/[tokenId]/{page,activate/page}.tsx`, `apps/agents/src/{runner,fund,register,attest}.ts`, `packages/agent-index/src/{classify.ts,sources/scan8004.ts,sources/merged.ts}`, `packages/agent-index/scripts/seed.ts`, `ops/deploy-aleph.sh`, `README.md`.

---

# Phase 1: Harden the judge path

## Task 1: Runner URL resolution module

**Files:**
- Create: `apps/web/src/lib/kv.ts`
- Create: `apps/web/src/lib/runner-url.ts`
- Create: `apps/web/tests/runner-url.test.ts`
- Modify: `apps/web/package.json` (add a `test` script)

**Interfaces:**
- Produces: `isSafeRunnerUrl(value: unknown): value is string`, `runnerBase(): Promise<string>`, `runnerUrl(path: string): Promise<string>`, `DEFAULT_RUNNER_BASE: string`.
- Produces (kv.ts): `kvGet(key: string): Promise<string | null>`, `kvSet(key: string, value: string): Promise<boolean>`, `kvAvailable(): boolean`.
- Consumes: nothing.

**Context:** Today `agents-endpoint.ts` and `proof.ts` each import `grid.json` and read `x402.endpoint`, an ephemeral trycloudflare URL. A tunnel restart breaks the proof feed, the x402 endpoints, and managed activation until someone edits four JSON files and redeploys. This module centralises resolution and adds a writable tier.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/runner-url.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSafeRunnerUrl } from '../src/lib/runner-url';

test('accepts https origins', () => {
  assert.equal(isSafeRunnerUrl('https://example.trycloudflare.com'), true);
  assert.equal(isSafeRunnerUrl('https://agents.example.ts.net/'), true);
});

test('rejects non-https, malformed, and internal targets', () => {
  assert.equal(isSafeRunnerUrl('http://example.com'), false);
  assert.equal(isSafeRunnerUrl('not a url'), false);
  assert.equal(isSafeRunnerUrl('https://localhost:4410'), false);
  assert.equal(isSafeRunnerUrl('https://127.0.0.1'), false);
  assert.equal(isSafeRunnerUrl('https://169.254.169.254'), false);
  assert.equal(isSafeRunnerUrl(''), false);
  assert.equal(isSafeRunnerUrl(null), false);
});

test('rejects a url longer than 300 chars', () => {
  assert.equal(isSafeRunnerUrl(`https://a.example.com/${'x'.repeat(300)}`), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx tsx --test tests/runner-url.test.ts`
Expected: FAIL, cannot find module `../src/lib/runner-url`.

- [ ] **Step 3: Write `apps/web/src/lib/kv.ts`**

```ts
import 'server-only';

/**
 * Minimal Upstash-REST key/value client. No dependency, and a no-op when the
 * env vars are absent so every caller keeps working without a KV provisioned.
 */
const URL_BASE = process.env.KV_REST_API_URL?.trim();
const TOKEN = process.env.KV_REST_API_TOKEN?.trim();

export function kvAvailable(): boolean {
  return Boolean(URL_BASE && TOKEN);
}

export async function kvGet(key: string): Promise<string | null> {
  if (!kvAvailable()) return null;
  try {
    const res = await fetch(`${URL_BASE}/get/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(3_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    return typeof body.result === 'string' ? body.result : null;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: string): Promise<boolean> {
  if (!kvAvailable()) return false;
  try {
    const res = await fetch(`${URL_BASE}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
      body: value,
      signal: AbortSignal.timeout(3_000),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write `apps/web/src/lib/runner-url.ts`**

```ts
import 'server-only';

import { kvGet } from './kv';

/**
 * Last-known runner base, committed as the floor so the site still resolves an
 * endpoint with no env var and no KV. Rotations land in KV (see
 * /api/ops/runner-url) and never require a redeploy.
 */
export const DEFAULT_RUNNER_BASE = 'https://continuous-locator-four-christine.trycloudflare.com';

export const RUNNER_URL_KEY = 'agripinaa:runner-url';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);

/** https only, public host, sane length. The tunnel is an untrusted boundary. */
export function isSafeRunnerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return false;
  }
  return true;
}

/**
 * Resolution order: AGENTS_BASE_URL (manual override, wins for local dev and
 * incident response) -> KV (self-reported by the VM on every tunnel start) ->
 * the committed default.
 */
export async function runnerBase(): Promise<string> {
  const configured = process.env.AGENTS_BASE_URL?.trim();
  if (isSafeRunnerUrl(configured)) return configured;
  const stored = await kvGet(RUNNER_URL_KEY);
  if (isSafeRunnerUrl(stored)) return stored;
  return DEFAULT_RUNNER_BASE;
}

export async function runnerUrl(path: string): Promise<string> {
  return new URL(path, await runnerBase()).toString();
}
```

- [ ] **Step 5: Add the web test script**

In `apps/web/package.json`, add to `scripts`: `"test": "tsx --test tests/*.test.ts"`, and add `"tsx": "^4.19.0"` to `devDependencies`. Run `pnpm install` at the repo root afterwards.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @agripinaa/web test`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/kv.ts apps/web/src/lib/runner-url.ts apps/web/tests/runner-url.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "web: single source of truth for the agent runner base url

The runner endpoint was read straight from the committed grid manifest in two
places, so every tunnel rotation needed four JSON edits plus a redeploy before
the proof feed, x402 endpoints, and managed activation came back. Resolution now
runs env override -> KV -> committed default, behind an https/public-host
validator (the tunnel is an untrusted boundary).

Verified: pnpm --filter @agripinaa/web test (3 passing)"
```

---

## Task 2: Point the web app at the resolver

**Files:**
- Modify: `apps/web/src/lib/agents-endpoint.ts`
- Modify: `apps/web/src/lib/proof.ts:32-40` (`proofEndpoint`), `:138-151` (`getRunnerEvents`)
- Modify: any caller of `agentsUrl` (find with `rg "agentsUrl|agentsBase" apps/web/src`)

**Interfaces:**
- Consumes: `runnerBase`, `runnerUrl` from Task 1.
- Produces: `agentsBase(): Promise<string>` and `agentsUrl(path: string): Promise<string>` (both now async).

- [ ] **Step 1: Find every caller**

Run: `rg -n "agentsUrl|agentsBase|gridManifest" apps/web/src`
Expected: hits in `agents-endpoint.ts`, `proof.ts`, and the managed API routes. Note each; they all become `await`.

- [ ] **Step 2: Rewrite `agents-endpoint.ts`**

```ts
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
```

- [ ] **Step 3: Rewrite `proofEndpoint` in `proof.ts`**

Replace the `gridManifest` import and the `proofEndpoint` function with:

```ts
import { runnerUrl } from './runner-url';

async function proofEndpoint(): Promise<string> {
  return runnerUrl('/proof');
}
```

and in `getRunnerEvents`, change `fetch(proofEndpoint(), ...)` to `fetch(await proofEndpoint(), ...)`.

- [ ] **Step 4: Await every other caller**

Update each hit from Step 1 so `agentsUrl(...)`/`agentsBase()` is awaited. Then run `pnpm --filter @agripinaa/web typecheck`.
Expected: no errors. TypeScript will flag any missed call site as `Promise<string>` used as `string`.

- [ ] **Step 5: Verify the proof feed still resolves**

Run: `pnpm --filter @agripinaa/web build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib apps/web/src/app
git commit -m "web: resolve the runner endpoint through the shared resolver

agents-endpoint and proof.ts each imported the grid manifest and read
x402.endpoint directly. Both now go through runnerBase()/runnerUrl(), so a
rotated tunnel is picked up from KV without a redeploy.

Verified: web typecheck + build green"
```

---

## Task 3: Dynamic manifest route

**Files:**
- Create: `apps/web/src/lib/manifests.ts`
- Create: `apps/web/src/app/manifests/[slug]/route.ts`
- Delete: `apps/web/public/manifests/grid.json`, `health-factor.json`, `yield.json`, `lp-range.json`
- Create: `apps/web/tests/manifests.test.ts`

**Interfaces:**
- Consumes: `runnerBase` (Task 1).
- Produces: `MANIFEST_CONTENT: Record<string, ManifestBase>`, `buildManifest(slug: string, runnerBase: string): Manifest | null`.

**Context:** On-chain `tokenURI`s point at `https://agripinaa.vercel.app/manifests/<slug>.json`. Those paths must keep resolving byte-compatibly; only the `x402.endpoint` value changes per request. Read `node_modules/next/dist/docs/01-app/` on Route Handlers before writing the route.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/manifests.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildManifest, MANIFEST_SLUGS } from '../src/lib/manifests';

test('every registered agent has a manifest', () => {
  assert.deepEqual([...MANIFEST_SLUGS].sort(), ['grid', 'health-factor', 'lp-range', 'yield']);
});

test('injects the runner base into the x402 endpoint', () => {
  const m = buildManifest('grid', 'https://runner.example.com');
  assert.equal(m?.x402.endpoint, 'https://runner.example.com/grid/status');
  assert.equal(m?.category, 'grid');
  assert.equal(m?.name, 'Agripinaa Grid');
});

test('unknown slug returns null', () => {
  assert.equal(buildManifest('nope', 'https://runner.example.com'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/web test`
Expected: FAIL, cannot find module `../src/lib/manifests`.

- [ ] **Step 3: Write `manifests.ts`**

Copy the four existing JSON bodies verbatim into a typed record, minus the `x402.endpoint` value (which is injected). Preserve every existing field and value exactly, including `description`, `capabilities`, `execution`, `safety`, `priceUsdt: "0.05"`, and `note: "live"`. Set `image` to `https://agripinaa.vercel.app/agent-icon.png` (Task 9 creates that asset; the current `icon.png` 404s).

```ts
export interface Manifest {
  name: string;
  description: string;
  category: string;
  image: string;
  capabilities: string[];
  execution: { venue: string; pair?: string; chainId: number };
  safety: Record<string, number>;
  x402: { endpoint: string; priceUsdt: string; note: string };
}

type ManifestBase = Omit<Manifest, 'x402'> & { x402: Omit<Manifest['x402'], 'endpoint'> };

const BASE: Record<string, ManifestBase> = {
  grid: {
    name: 'Agripinaa Grid',
    description: 'Mean-reversion grid trader on the WBNB/USDT pair. Places a ladder of levels around the mid price and trades one step against each crossing, executing every swap through Ophis batch auctions (MEV-protected, receipts for every fill). Halts itself on trend breakouts and daily loss limits.',
    category: 'grid',
    image: 'https://agripinaa.vercel.app/agent-icon.png',
    capabilities: ['trading', 'x402-status'],
    execution: { venue: 'ophis', pair: 'WBNB/USDT', chainId: 56 },
    safety: { maxTradesPerDay: 12, perTradeClipUsd: 2, lossHaltPct: 5, trendHaltBandPct: 6 },
    x402: { priceUsdt: '0.05', note: 'live' },
  },
  // 'health-factor', 'yield', 'lp-range': copy each field verbatim from the
  // corresponding apps/web/public/manifests/<slug>.json before deleting it.
};

export const MANIFEST_SLUGS = Object.keys(BASE);

export function buildManifest(slug: string, runnerBase: string): Manifest | null {
  const base = BASE[slug];
  if (!base) return null;
  return {
    ...base,
    x402: { ...base.x402, endpoint: new URL(`/${slug}/status`, runnerBase).toString() },
  };
}
```

- [ ] **Step 4: Write the route handler**

`apps/web/src/app/manifests/[slug]/route.ts`:

```ts
import { buildManifest, MANIFEST_SLUGS } from '@/lib/manifests';
import { runnerBase } from '@/lib/runner-url';

export function generateStaticParams() {
  return MANIFEST_SLUGS.map((slug) => ({ slug: `${slug}.json` }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const manifest = buildManifest(slug.replace(/\.json$/, ''), await runnerBase());
  if (!manifest) return new Response('Not found', { status: 404 });
  return Response.json(manifest, {
    headers: { 'cache-control': 'public, max-age=60, s-maxage=60' },
  });
}
```

- [ ] **Step 5: Delete the static manifests and verify parity**

```bash
rm apps/web/public/manifests/*.json
pnpm --filter @agripinaa/web build
pnpm --filter @agripinaa/web start &
sleep 5
for s in grid health-factor yield lp-range; do curl -sf "http://localhost:3000/manifests/$s.json" | head -c 200; echo; done
kill %1
```
Expected: each returns JSON with the agent name and an `x402.endpoint` ending `/<slug>/status`.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/manifests.ts apps/web/src/app/manifests apps/web/tests/manifests.test.ts apps/web/public/manifests
git commit -m "web: serve agent manifests dynamically with a live runner endpoint

The four manifests were static files carrying a hardcoded quick-tunnel URL, so
each rotation required editing them and redeploying before x402 clients could
reach the runner. Same paths, same bodies, endpoint injected per request from
the shared resolver. On-chain tokenURIs are unchanged.

Verified: web test + typecheck + build green; all four manifest URLs served
locally with the resolved endpoint"
```

---

## Task 4: VM self-report endpoint

**Files:**
- Create: `apps/web/src/app/api/ops/runner-url/route.ts`
- Create: `ops/report-runner-url.sh`
- Modify: `ops/deploy-aleph.sh` (tunnel unit calls the reporter after start)
- Modify: `ops/launch.md` (document `OPS_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and the Tailscale Funnel alternative)

**Interfaces:**
- Consumes: `kvSet`, `RUNNER_URL_KEY`, `isSafeRunnerUrl`, and `assertResolvedHostPublic` from `@agripinaa/shared/ssrf`.
- Produces: `POST /api/ops/runner-url` accepting `{ "url": "https://..." }` with header `authorization: Bearer <OPS_TOKEN>`.

**Security requirement carried over from `f61723c`.** `isSafeRunnerUrl` is synchronous and runs on every read, so it validates the host literal but deliberately does not resolve DNS. That leaves one gap: a public-looking hostname whose A record points at a private address (169.254.169.254, 127.x, RFC1918). This route is where a candidate first enters the system, and it is already async, so close it here. After `isSafeRunnerUrl` passes, `await assertResolvedHostPublic(new URL(url))` and reject with 400 if it throws. That function is already written and tested in `packages/shared/src/ssrf.ts:54`; do not write a second resolver. Add a test for it using the injectable `LookupFn` parameter (a lookup returning `169.254.169.254` must be rejected), which is why that parameter exists.

- [ ] **Step 1: Write the route**

```ts
import { kvSet } from '@/lib/kv';
import { isSafeRunnerUrl, RUNNER_URL_KEY } from '@/lib/runner-url';

/** The VM posts its freshly assigned tunnel URL here on every tunnel start. */
export async function POST(request: Request) {
  const token = process.env.OPS_TOKEN?.trim();
  if (!token) return new Response('ops token not configured', { status: 503 });
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const url = (body as { url?: unknown })?.url;
  if (!isSafeRunnerUrl(url)) return new Response('bad url', { status: 400 });

  const ok = await kvSet(RUNNER_URL_KEY, url);
  return Response.json({ stored: ok, url }, { status: ok ? 200 : 503 });
}
```

- [ ] **Step 2: Test the auth and validation paths manually**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:3000/api/ops/runner-url -d '{"url":"https://x.trycloudflare.com"}'   # expect 401 or 503
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:3000/api/ops/runner-url -H 'authorization: Bearer test' -d '{"url":"http://evil"}'  # expect 400 when OPS_TOKEN=test
kill %1
```
Expected: unauthenticated 401 (or 503 with no token configured), malformed URL 400.

- [ ] **Step 3: Write the VM reporter**

`ops/report-runner-url.sh`:

```bash
#!/usr/bin/env bash
# Report this host's current public runner URL to the marketplace, so a rotated
# quick tunnel is picked up without a redeploy. Reads the URL from the
# cloudflared log; exits non-zero if it cannot find one.
set -euo pipefail

SITE="${AGRIPINAA_SITE:-https://agripinaa.vercel.app}"
: "${OPS_TOKEN:?OPS_TOKEN must be set}"
LOG="${CLOUDFLARED_LOG:-/var/log/cloudflared.log}"

for _ in $(seq 1 30); do
  url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | tail -1 || true)"
  [ -n "$url" ] && break
  sleep 2
done
[ -n "${url:-}" ] || { echo "no tunnel url in $LOG" >&2; exit 1; }

echo "reporting $url"
curl -fsS -XPOST "$SITE/api/ops/runner-url" \
  -H "authorization: Bearer $OPS_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"$url\"}"
echo
```

Make it executable: `chmod +x ops/report-runner-url.sh`.

- [ ] **Step 4: Wire it into the tunnel unit**

In `ops/deploy-aleph.sh`, find the `agripinaa-tunnel` systemd unit definition and add `ExecStartPost=/bin/bash -c 'OPS_TOKEN=... /opt/agripinaa/ops/report-runner-url.sh'` (reading `OPS_TOKEN` from the unit's `EnvironmentFile`). Keep the existing `ExecStart` unchanged.

- [ ] **Step 5: Document the operator steps**

Append to `ops/launch.md` a section covering: the three env vars on Vercel (`OPS_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`), how to provision Upstash from the Vercel dashboard, the matching `OPS_TOKEN` on the VM, and the preferred permanent alternative: install Tailscale on the VM and run `tailscale funnel 4410 on` for a stable `https://<host>.<tailnet>.ts.net` URL, which is then set once as `AGENTS_BASE_URL` and needs no rotation at all.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api/ops ops/report-runner-url.sh ops/deploy-aleph.sh ops/launch.md
git commit -m "ops: let the runner self-report its tunnel url

A quick-tunnel restart used to silently break the proof feed, the x402
endpoints, and managed activation until someone rewrote four manifests and
redeployed. The tunnel unit now posts its assigned URL to a bearer-authenticated
route that validates it and stores it in KV, so recovery is automatic. launch.md
also documents the Tailscale Funnel route to a permanent hostname.

Verified: route returns 401 unauthenticated and 400 on a non-https url; web
build green"
```

---

## Task 5: BSC-scoped, server-rendered stats

**Files:**
- Modify: `packages/agent-index/src/sources/scan8004.ts:297-308` (`stats`)
- Modify: `apps/web/src/app/page.tsx:11-38` (`StatsStrip`)
- Create: `packages/agent-index/tests/stats.test.ts`

**Interfaces:**
- Consumes: existing `keyedFetch`, `API_KEY` in `scan8004.ts`.
- Produces: `stats(chainId)` returning the chain-scoped total when a key is present.

**Context:** The public `/stats` endpoint ignores `chain_id` (verified live 2026-08-24: 765,100 with and without the filter), so a BSC marketplace shows the all-chains number. The keyed `/agents` response carries a real per-chain `total` (~258k for BSC).

- [ ] **Step 1: Write the failing test**

Create `packages/agent-index/tests/stats.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chainScopedTotal } from '../src/sources/scan8004';

test('prefers the keyed per-chain total', () => {
  assert.equal(chainScopedTotal({ keyedTotal: 257873, publicTotal: 765100 }), 257873);
});

test('falls back to the public total when unkeyed', () => {
  assert.equal(chainScopedTotal({ keyedTotal: null, publicTotal: 765100 }), 765100);
});

test('returns null when neither is available', () => {
  assert.equal(chainScopedTotal({ keyedTotal: null, publicTotal: null }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/agent-index test`
Expected: FAIL, `chainScopedTotal` is not exported.

- [ ] **Step 3: Implement**

In `scan8004.ts`, add the pure helper and use it in `stats`:

```ts
export function chainScopedTotal(input: {
  keyedTotal: number | null;
  publicTotal: number | null;
}): number | null {
  return input.keyedTotal ?? input.publicTotal ?? null;
}
```

Then rewrite `stats`:

```ts
  async stats(chainId: number): Promise<IndexStats> {
    const asOf = new Date().toISOString();
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

    // The public /stats endpoint ignores chain_id upstream, so it reports the
    // all-chains figure. When a key is present the keyed /agents envelope
    // carries the real per-chain total; use that and label it BSC-scoped.
    let keyedTotal: number | null = null;
    if (API_KEY) {
      try {
        const res = await keyedFetch<{ items: unknown[]; total: number }>('/agents', {
          chain_id: chainId,
          limit: 1,
          offset: 0,
        });
        keyedTotal = num(res.total);
      } catch {
        keyedTotal = null;
      }
    }

    let publicTotal: number | null = null;
    let totalFeedbacks: number | null = null;
    try {
      const res = await scanFetch<Record<string, unknown>>('/stats', { chain_id: chainId });
      publicTotal = num(res.data['total_agents']) ?? num(res.data['agents']) ?? null;
      totalFeedbacks = num(res.data['total_feedbacks']) ?? num(res.data['feedbacks']) ?? null;
    } catch {
      /* keyed total may still stand alone */
    }

    return {
      totalAgents: chainScopedTotal({ keyedTotal, publicTotal }),
      chainScoped: keyedTotal != null,
      totalFeedbacks,
      asOf,
      source: this.name,
    };
  }
```

Add `chainScoped: boolean` to the `IndexStats` interface in `packages/agent-index/src/types.ts`, and set `chainScoped: false` in any other implementation of `stats` (check `merged.ts` and `source.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agripinaa/agent-index test`
Expected: PASS, 3 new tests.

- [ ] **Step 5: Fix the stats strip copy and remove the slogan tiles**

In `apps/web/src/app/page.tsx`, replace the `items` array in `StatsStrip` so it never renders a zero or a slogan styled as a metric:

```tsx
  const dir = await listDirectory();
  const items = [
    {
      value: stats.totalAgents != null ? stats.totalAgents.toLocaleString() : "—",
      label: stats.chainScoped
        ? "ERC-8004 agents registered on BSC"
        : "ERC-8004 agents registered",
    },
    {
      value: String(dir.verified.length),
      label: "live Agripinaa agents on mainnet",
    },
    {
      value: String(dir.registry.length),
      label: "indexed agents you can browse",
    },
  ];
```

Keep the existing `Suspense` boundary and `AnimatedNumber`.

- [ ] **Step 6: Verify rendered HTML carries real numbers**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000 | rg -o 'agents registered[^<]*' | head -3
curl -s localhost:3000 | rg -c '>0<' || true
kill %1
```
Expected: the label reads "on BSC" and no stat tile renders `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-index apps/web/src/app/page.tsx
git commit -m "index+web: report a BSC-scoped agent total on the homepage

8004scan's public /stats ignores chain_id, so the headline stat on a BSC
marketplace was the all-chains figure. With a key present we now read the real
per-chain total from the keyed /agents envelope and say 'on BSC'; the two slogan
tiles styled as metrics are replaced by live agent counts.

Verified: agent-index tests (3 new) pass; rendered homepage HTML shows the
BSC-scoped label and no zero tiles"
```

---

## Task 6: Proof feed populated at first paint

**Files:**
- Modify: `apps/web/src/components/ProofFeed.tsx`
- Modify: `apps/web/src/app/proof/page.tsx`

**Interfaces:**
- Consumes: `getProofFeed()` from `apps/web/src/lib/proof.ts` (already server-side and cached).
- Produces: `ProofFeed` accepting `initial?: ProofFeedPayload`.

**Context:** The feed currently renders a client skeleton then polls, so served HTML (and any judge with a slow first load) sees "warming up" or "reconnecting...". `getProofFeed` already merges the Ophis settlement backfill server-side; pass its result in as initial state.

- [ ] **Step 1: Read the component**

Run: `cat apps/web/src/components/ProofFeed.tsx`
Note whether it is a client component and how it fetches `/api/proof`.

- [ ] **Step 2: Add an `initial` prop**

Give `ProofFeed` an optional `initial?: ProofFeedPayload` prop used as the initial state value, so the first render has rows. Polling continues to replace it. When `initial` is absent, behaviour is unchanged.

- [ ] **Step 3: Pass server data at both call sites**

In `apps/web/src/app/page.tsx`, wrap the existing `<ProofFeed compact />` in an async server component that awaits `getProofFeed()` and passes it as `initial`, keeping the `Suspense` boundary. Do the same on `apps/web/src/app/proof/page.tsx`.

- [ ] **Step 4: Verify the served HTML contains rows**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/proof | rg -c 'Ophis|Filled|bps'
kill %1
```
Expected: a non-zero count (rows present in server-rendered HTML, not just after hydration).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ProofFeed.tsx apps/web/src/app/page.tsx apps/web/src/app/proof/page.tsx
git commit -m "web: render the proof feed with rows on first paint

The feed mounted empty and filled in after a client poll, so served HTML (and
anyone on a slow first load) saw 'warming up'. getProofFeed already merges the
Ophis settlement backfill server-side; its payload is now passed in as initial
state and polling takes over from there.

Verified: curl of /proof shows settlement rows in the server-rendered HTML"
```

---

## Task 7: One score per agent everywhere

**Files:**
- Modify: `apps/web/src/lib/data.ts:70-99` (`listAgents`)
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx:189-206` (attested value)
- Create: `apps/web/tests/attestation-merge.test.ts`

**Interfaces:**
- Consumes: `getOnchainAttestation(tokenId)` from `onchain-rep.ts`.
- Produces: `withOnchainAttestation(agents: AgentSummary[]): Promise<AgentSummary[]>` exported from `data.ts`.

**Context:** `listDirectory` enriches pinned agents with the on-chain attestation, `listAgents` does not. `/agents` and the homepage use the former, category hubs use the latter, so the same agent shows Score 0 on a hub card and 100 on its detail page. Extract the enrichment and use it in both.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/attestation-merge.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeAttestation } from '../src/lib/attestation-merge';

const agent = {
  tokenId: '269703',
  trust: { totalScore: 0, totalFeedbacks: 0, rank: null, isVerified: false },
} as never;

test('on-chain attestation wins over a lagging indexer score', () => {
  const merged = mergeAttestation(agent, { value: 100, count: 1 });
  assert.equal(merged.trust.totalScore, 100);
  assert.equal(merged.trust.totalFeedbacks, 1);
});

test('a missing attestation leaves the agent untouched', () => {
  assert.equal(mergeAttestation(agent, null), agent);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/web test`
Expected: FAIL, cannot find `../src/lib/attestation-merge`.

- [ ] **Step 3: Extract the pure merge**

Create `apps/web/src/lib/attestation-merge.ts`:

```ts
import type { AgentSummary } from '@agripinaa/agent-index';

import type { OnchainAttestation } from './onchain-rep';

/**
 * The upstream indexer lags our ERC-8004 writes, so its score reads 0 for
 * agents we have attested. The registry read is the source of truth.
 */
export function mergeAttestation(
  agent: AgentSummary,
  attestation: OnchainAttestation | null,
): AgentSummary {
  if (!attestation) return agent;
  return {
    ...agent,
    trust: {
      ...agent.trust,
      totalScore: attestation.value,
      totalFeedbacks: attestation.count,
    },
  };
}
```

- [ ] **Step 4: Use it in both list paths**

In `data.ts`, add:

```ts
export async function withOnchainAttestation(agents: AgentSummary[]): Promise<AgentSummary[]> {
  return Promise.all(
    agents.map(async (a) =>
      mergeAttestation(a, await getOnchainAttestation(a.tokenId).catch(() => null)),
    ),
  );
}
```

Replace the inline enrichment in `listDirectory` with `const enriched = await withOnchainAttestation(verified);`, and in `listAgents` wrap the pinned agents: `const pinnedEnriched = await withOnchainAttestation(pinned);` then use `pinnedEnriched` when composing `items`.

- [ ] **Step 5: Fix the empty "Attested" field on the detail page**

In `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx`, the `TrustStat` labelled `Attested` renders `String(attestation.value)`. Confirm the value is a number and render `—` when it is `null`/`undefined` rather than an empty string:

```tsx
value={
  attestation && Number.isFinite(attestation.value)
    ? String(attestation.value)
    : agent.trust.totalScore != null
      ? String(agent.trust.totalScore)
      : "—"
}
```

- [ ] **Step 6: Run tests and verify parity in the browser**

```bash
pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/c/grid | rg -o 'Score</span><span[^>]*>[^<]*' | head -3
curl -s localhost:3000/agent/56/269703 | rg -o 'Attested[^<]*<[^>]*>[^<]*' | head -3
kill %1
```
Expected: the hub card score matches the detail page value (both 100, not 0 vs 100).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib apps/web/src/app/agent apps/web/tests/attestation-merge.test.ts
git commit -m "web: show one score per agent across cards and detail pages

listDirectory enriched pinned agents from the ReputationRegistry but listAgents
did not, so a category hub card read Score 0 while the same agent's detail page
read 100. The merge is now a shared pure function used by both paths, and the
detail page's Attested field falls back to a dash instead of rendering empty.

Verified: web tests (2 new) pass; /c/grid card score and /agent/56/269703 now
agree"
```

---

## Task 8: No dead ends on unverified agents

**Files:**
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx` (primary CTA)
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/activate/page.tsx` (warning gate)
- Create: `apps/web/src/lib/activatable.ts`
- Create: `apps/web/tests/activatable.test.ts`

**Interfaces:**
- Produces: `isActivatable(input: { tokenId: string; endpointLive: boolean }): boolean`, `ACTIVATION_BLOCKED_COPY: string`.
- Consumes: `isVerified` from `verified.ts`.

**Context:** "Activate agent" is the primary CTA on every registry agent, including skeletal ones with no runner. A judge can be walked through creating a passkey wallet and depositing BNB for an agent that will never act. The rubric penalises dead ends explicitly.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isActivatable } from '../src/lib/activatable';

test('first-party agents are activatable', () => {
  assert.equal(isActivatable({ tokenId: '269703', endpointLive: false }), true);
});

test('third-party agents need a live probed endpoint', () => {
  assert.equal(isActivatable({ tokenId: '999999', endpointLive: false }), false);
  assert.equal(isActivatable({ tokenId: '999999', endpointLive: true }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/web test`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `activatable.ts`**

```ts
import { isVerified } from './verified';

/**
 * Hiring an agent moves real money, so the activate path is offered only where
 * something will actually act: our own agents, or a claimed third-party agent
 * whose endpoint answered a liveness probe.
 */
export function isActivatable(input: { tokenId: string; endpointLive: boolean }): boolean {
  return isVerified(input.tokenId) || input.endpointLive;
}

export const ACTIVATION_BLOCKED_COPY =
  'This agent is an on-chain registration we index, not one we run. Nobody has claimed it and no endpoint answered our probe, so activating it would grant a session to something that cannot act. You can still inspect its identity, owner, and feedback on-chain.';
```

- [ ] **Step 4: Swap the CTA**

On the agent detail page, when `isActivatable` is false, render "Inspect on-chain identity" (linking to the BscScan identity view already present in the Identity panel) in place of the activate button, plus one muted line of `ACTIVATION_BLOCKED_COPY`. When true, the existing activate button is unchanged. Pass `endpointLive: false` for now; Task 22 supplies the real probe result.

- [ ] **Step 5: Gate the wizard for deep links**

On `activate/page.tsx`, when `isActivatable` is false, render a bordered warning panel with `ACTIVATION_BLOCKED_COPY` and a link back to the agent page **before** the wizard mounts, so no wallet creation step is reachable.

- [ ] **Step 6: Verify both paths**

```bash
pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/agent/56/269703 | rg -c 'Activate'          # expect >= 1
curl -s "localhost:3000/agent/56/297380/activate" | rg -c 'cannot act'  # expect 1
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/activatable.ts apps/web/tests/activatable.test.ts apps/web/src/app/agent
git commit -m "web: stop offering activation for agents that cannot act

Activate was the primary CTA on every indexed registration, so a visitor could
be walked through creating a passkey wallet and funding it for an agent with no
runner behind it. Unclaimed, unprobed agents now lead with on-chain inspection,
and a deep link into the wizard hits a warning panel before any wallet step.

Verified: web tests (2 new) pass; a registry agent's activate route renders the
gate, a first-party agent's does not"
```

---

## Task 9: Public-launch basics

**Files:**
- Create: `apps/web/src/app/not-found.tsx`, `error.tsx`, `loading.tsx`, `robots.ts`, `sitemap.ts`, `opengraph-image.tsx`
- Create: `apps/web/public/agent-icon.png` (referenced by manifests)
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx`, `apps/web/src/app/c/[category]/page.tsx` (add `generateMetadata`)
- Delete: `apps/web/public/{file,globe,next,vercel,window}.svg` (create-next-app leftovers)

**Context:** Read `node_modules/next/dist/docs/01-app/` on `generateMetadata`, `sitemap`, `robots`, and file-based OG images before writing. Metadata APIs changed in Next 16.

While here, fix three pieces of existing copy and one formatting bug:

1. The root title in `layout.tsx` is `Agripinaa — the front door for every agent on BSC`, which uses an em dash (house style forbids it; use a colon or comma). Confirmed in the live HTML on 2026-08-24.
2. `apps/web/src/app/proof/page.tsx:7` has a second one: `title: 'Live proof feed — Agripinaa'`. Found during Task 6 and deliberately left there rather than folding unrelated copy into that commit.
3. **`toLocaleString()` with no explicit locale is non-deterministic across environments.** The Task 5 stats strip renders the agent total through it, which produced `278 802` on a French-locale dev machine and will produce `278,802` on Vercel. A server-rendered number must not depend on the host's ICU locale. Pass an explicit locale at the call site.
4. Verify the served homepage still renders no `0` in any stat tile before hydration (the pre-Task-5 baseline had two) and that the proof feed still ships rows.

- [ ] **Step 1: Add per-page metadata**

Add `generateMetadata` to the agent detail page returning `{ title: "<agent name> · Agripinaa", description: <agent description truncated to 155 chars> }`, and to the category page returning `{ title: "<category label> agents · Agripinaa", description: <category explainer> }`. Use the existing `CATEGORY_INFO` and the already-fetched agent data; do not add a second fetch (Next dedupes, but keep the same cached helpers).

- [ ] **Step 2: Add the route-level files**

`not-found.tsx` and `error.tsx` styled with the existing dark tokens (`border-border`, `bg-surface`, `text-muted`) and a link home. `loading.tsx` reusing the existing skeleton classes. `robots.ts` allowing everything and pointing at the sitemap. `sitemap.ts` listing `/`, `/agents`, `/proof`, `/funds`, `/leaderboard`, the four `/c/<category>` hubs, and the first-party agent pages from `VERIFIED_IDS`.

- [ ] **Step 3: Add an OG image and the agent icon**

`opengraph-image.tsx` using the `ImageResponse` API (see the Next docs entry for `opengraph-image`), rendering the wordmark, the tagline "The front door for every agent on BSC", and the dark amber theme. Generate `public/agent-icon.png` (512x512, dark background with the mark) so the manifest `image` field resolves.

- [ ] **Step 4: Remove the create-next-app leftovers**

```bash
git rm apps/web/public/file.svg apps/web/public/globe.svg apps/web/public/next.svg apps/web/public/vercel.svg apps/web/public/window.svg
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/robots.txt | head -5
curl -s localhost:3000/sitemap.xml | rg -c '<loc>'
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/agent-icon.png
curl -s localhost:3000/agent/56/269703 | rg -o '<title>[^<]*'
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/c/nonsense   # expect 404
kill %1
```
Expected: robots + sitemap render, icon returns 200, the agent page title carries the agent name, an unknown category 404s.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app apps/web/public
git commit -m "web: metadata, error pages, sitemap, and og image

The site shipped with one shared tab title, the default Next 404, no robots or
sitemap, no share image, a manifest icon URL that 404s, and the create-next-app
sample SVGs still in public/. All of it is judge- and crawler-visible.

Verified: robots.txt and sitemap.xml served; agent page title carries the agent
name; /agent-icon.png returns 200; unknown category 404s"
```

---

## Phase 1 complete, 2026-08-24

All nine tasks done plus three unplanned live-agent fixes and one security fix. Repo went from 202 to **270 passing, 0 failing** (web 32, agents 162, session-kit 37, exec-metrics 25, shared 7, agent-index 7).

Judge-path state now: no stat tile renders `0` in served HTML (the culprit was `AnimatedNumber` initialising numeric state to `'0'`, so every tile shipped a zero regardless of value), the agent total is BSC-scoped at ~278k, the proof feed ships 14 rows on `/proof` and 5 on `/`, hub cards and detail pages agree on score, unactivatable agents lead with on-chain inspection instead of a wallet-funding dead end, and robots/sitemap/OG/per-page titles/custom 404 all serve.

**Carry these into later tasks:**

- **Do NOT add a root `loading.tsx`.** Measured both ways: with one, `/c/nonsense` answers 200 (soft 404); without, 404. Next streams once a Suspense fallback renders, so a root-level loading wrapper sends the status before `notFound()` runs. Segment-level loading files are fine where no `notFound()` path passes through them.
- **`dynamicParams = false` is unusable in this app**: incompatible with `nextConfig.cacheComponents`.
- **Provenance is per-field, not per-record.** `TrustData.scoreSource?: '8004scan' | 'registry'` marks where the score came from, because `mergeAttestation` overrides only `totalScore` and `totalFeedbacks` while `rank`, `healthScore`, `averageScore` and `breakdown` stay with the indexer, and no on-chain read produces a rank at all. `trustProvenanceLabel(trust)` renders both when they differ. Keep that shape when claims add a third source.
- **`ACTIVATION_BLOCKED_COPY` asserts claim state that `isActivatable` does not evaluate.** It reads correctly only while claims do not exist. Task 19-21 must either pass claim state into `isActivatable` or rewrite that sentence.
- `apps/web/src/lib/site.ts` now holds `SITE_URL`, `siteUrl()`, `clampDescription()`. Use it rather than hardcoding the origin again.
- Satori (OG image, agent icon) resolves no CSS custom properties, so `globals.css` tokens are duplicated as literals in `opengraph-image.tsx` and `scripts/make-agent-icon.tsx`.

**Funding, resolved 2026-08-24 18:42 CEST.** Owner sent 0.01409 BNB; treasury holds 0.01448 BNB, 0.01941 across all wallets (~$13.73). **Gas was never the constraint**: BSC is at 0.05 gwei, so an ERC-8004 registration costs $0.007 and a V3 mint $0.018, and Ophis orders are signed off-chain and solver-settled so agents pay nothing per swap. My earlier "19 swaps of gas" figure assumed 1 gwei and agent-paid swap gas; both were wrong by more than an order of magnitude. Treat the BNB as trading capital to be wrapped, not as a gas reserve. Transferred 1.5 USDT to the grid (`0xb7b862cd55d2020dfe87b18b5394eca8c089fe686e8a42e44f2ac0b4ffd6d7e1`) to restore its buy side; its inventory went 4.52 to 6.01 and it is armed for buy:2 at 698.4.

Side effect worth knowing for Task 18: adding capital without resetting `inventoryStartUsd` (baseline 4.4928) loosens the drawdown guard, since the halt still triggers at inventory below 4.268, now a 29 percent fall rather than 5. The permanent-halt risk I flagged earlier is correspondingly lower, but the guard is now measuring something even less meaningful.

---

# Phase 2: Add-agent scaffold and four new agents

## Task 10: The shared agent registry

**Files:**
- Create: `packages/shared/src/agents.ts`
- Modify: `packages/shared/src/index.ts` (re-export), `packages/shared/package.json` (add `"./agents": "./src/agents.ts"` to `exports`)
- Create: `packages/shared/tests/agents.test.ts`
- Modify: `packages/shared/src/proof.ts` (derive `PROOF_AGENTS` from the registry)

**Interfaces:**
- Produces: `AGENTS: Record<AgentSlug, AgentRecord>`, `AGENT_LIST: AgentRecord[]`, `agentBySlug(slug: string): AgentRecord | undefined`, `agentByTokenId(id: string): AgentRecord | undefined`, `AgentSlug`, `AgentRecord`.
- `AgentRecord` fields: `slug`, `tokenId | null`, `name`, `category`, `wallet`, `walletFile`, `managed: boolean`, `backfillOphisTrades: boolean`, `manifest: ManifestBase`, `funding: { bnb: string; usdt?: string; usdc?: string; wbnb?: string }`, `registrationTx: string | null`, `attestation: { txHash: string; verifier: string; tag: string; feedbackHash: string } | null`, `proofs: ExecutionProof[]`.

**Context:** Per-agent identity is currently hand-maintained across `runner.ts` (`ALL`, `MANAGED_AGENTS`), `fund.ts` (`WALLET_NAMES`, `PLAN`), `register.ts` (`AGENT_NAMES`), `attest.ts`, `ops/set-x402-endpoint.sh`, `apps/web/src/lib/data.ts` (`PINNED_AGENT_IDS`), `apps/web/src/lib/verified.ts` (`VERIFIED_AGENTS`), and `apps/web/src/lib/manifests.ts`. Missing one edit leaves a new agent half-wired with no error. `tokenId` is nullable so an agent can exist in config before it is registered on-chain.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/tests/agents.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_LIST, AGENTS, agentBySlug, agentByTokenId } from '../src/agents';

test('the four live agents are registered with their on-chain ids', () => {
  assert.equal(AGENTS.grid.tokenId, '269703');
  assert.equal(AGENTS['health-factor'].tokenId, '269704');
  assert.equal(AGENTS.yield.tokenId, '269705');
  assert.equal(AGENTS['lp-range'].tokenId, '269706');
});

test('token ids and wallets are unique across agents', () => {
  const ids = AGENT_LIST.map((a) => a.tokenId).filter((id): id is string => id != null);
  const wallets = AGENT_LIST.map((a) => a.wallet.toLowerCase());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(wallets).size, wallets.length);
});

test('every agent carries a manifest with a category matching its record', () => {
  for (const a of AGENT_LIST) {
    assert.equal(a.manifest.category, a.category, `${a.slug} manifest category`);
    assert.ok(a.manifest.description.length > 40, `${a.slug} description`);
  }
});

test('lookup helpers agree with the record map', () => {
  assert.equal(agentBySlug('grid')?.tokenId, '269703');
  assert.equal(agentByTokenId('269705')?.slug, 'yield');
  assert.equal(agentBySlug('nope'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/shared test`
Expected: FAIL, cannot find `../src/agents`.

- [ ] **Step 3: Write `agents.ts`**

Populate one `AgentRecord` per existing agent by copying values from their current homes: wallets and `backfillOphisTrades` from `packages/shared/src/proof.ts`, manifest bodies from `apps/web/src/lib/manifests.ts` (Task 3), funding amounts from `apps/agents/src/fund.ts` `PLAN`, and `registrationTx` / `attestation` / `proofs` from `apps/web/src/lib/verified.ts`. Set `managed: true` for `yield` only.

- [ ] **Step 4: Derive `proof.ts` from the registry**

Rewrite `packages/shared/src/proof.ts` so `PROOF_AGENTS` and `PROOF_AGENT_LIST` are derived from `AGENT_LIST` (filtering to records with a `tokenId`), keeping the exported names and shapes so `apps/web/src/lib/proof.ts` and `apps/agents` need no changes yet.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agripinaa/shared test && pnpm -r typecheck`
Expected: PASS, no type errors anywhere in the monorepo.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "shared: one registry for first-party agent identity

Agent slug, token id, wallet, manifest, funding plan, and proof records were
duplicated across seven files with no error when an edit was missed, which is
the main reason adding an agent is risky. They now live in one record per agent;
proof.ts derives its exports from it so nothing downstream changed yet.

Verified: shared tests (4 new) pass; pnpm -r typecheck green"
```

---

## Task 11: Point every consumer at the registry

**Files:**
- Modify: `apps/agents/src/runner.ts:20-27` (`ALL`, `MANAGED_AGENTS`)
- Modify: `apps/agents/src/fund.ts` (`WALLET_NAMES`, `PLAN`, add `--only`)
- Modify: `apps/agents/src/register.ts` (`AGENT_NAMES`, add manifest preflight)
- Modify: `apps/web/src/lib/data.ts:29` (`PINNED_AGENT_IDS`)
- Modify: `apps/web/src/lib/verified.ts` (derive `VERIFIED_AGENTS` from the registry)
- Modify: `apps/web/src/lib/manifests.ts` (derive `BASE` from the registry)
- Modify: `ops/set-x402-endpoint.sh` (drive its loop from the registry, or delete it if Task 3 made it redundant)

**Interfaces:**
- Consumes: `AGENT_LIST`, `AGENTS`, `agentBySlug` from `@agripinaa/shared`.
- Produces: `fund.ts` accepts `--only <slug>`; `register.ts` aborts when a manifest URL does not resolve.

- [ ] **Step 1: Replace the hardcoded web lists**

In `data.ts`: `const PINNED_AGENT_IDS = AGENT_LIST.map((a) => a.tokenId).filter((id): id is string => id != null);`
In `verified.ts`: build `VERIFIED_AGENTS` by reducing `AGENT_LIST` (only records with `tokenId`, `registrationTx`, and `attestation`), keeping the exported type and the `isVerified` / `VERIFIED_IDS` API unchanged.
In `manifests.ts`: build `BASE` from `AGENT_LIST` manifest fields.

- [ ] **Step 2: Verify the web app is unchanged in behaviour**

Run: `pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web typecheck && pnpm --filter @agripinaa/web build`
Expected: all green, same four agents rendered.

- [ ] **Step 3: Drive the runner from the registry**

In `runner.ts`, keep the static module imports (each strategy is real code) but derive `MANAGED_AGENTS` from the registry:

```ts
const MANAGED_AGENTS = AGENT_LIST.filter((a) => a.managed).map((a) => a.slug);
```

and assert at boot that every module in `ALL` has a registry record, failing loudly otherwise:

```ts
for (const module of ALL) {
  if (!agentBySlug(module.name)) {
    throw new Error(`agent module "${module.name}" has no record in @agripinaa/shared agents.ts`);
  }
}
```

- [ ] **Step 4: Add `fund.ts --only`**

Derive `WALLET_NAMES` and `PLAN` from `AGENT_LIST` funding fields (keeping `facilitator` and any non-agent wallets as explicit extras), and add:

```ts
function selectedPlan(): typeof PLAN {
  const i = process.argv.indexOf('--only');
  if (i < 0) return PLAN;
  const wanted = new Set((process.argv[i + 1] ?? '').split(',').filter(Boolean));
  if (wanted.size === 0) throw new Error('--only needs a comma-separated list of wallet names');
  const filtered = PLAN.filter((entry) => wanted.has(entry.name));
  if (filtered.length !== wanted.size) {
    throw new Error(`--only names an unknown wallet: ${[...wanted].join(',')}`);
  }
  return filtered;
}
```

Use `selectedPlan()` in both `--gen` and `--execute`. Funding is not idempotent, so this prevents re-sending to already-funded wallets when adding one agent.

- [ ] **Step 5: Add the registration preflight**

In `register.ts`, before signing anything, HEAD/GET each agent's manifest URL and abort the whole run if any does not return 200 with parseable JSON whose `name` matches the record:

```ts
async function preflightManifest(record: AgentRecord): Promise<void> {
  const url = `${MANIFEST_BASE}/manifests/${record.slug}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`manifest ${url} responded ${res.status}; deploy it before registering`);
  const body = (await res.json()) as { name?: unknown };
  if (body.name !== record.name) {
    throw new Error(`manifest ${url} says name="${String(body.name)}", expected "${record.name}"`);
  }
}
```

A registration mints a permanent `tokenURI`; a 404 at mint time is unfixable.

- [ ] **Step 6: Verify without broadcasting**

```bash
pnpm --filter @agripinaa/agents typecheck
pnpm --filter @agripinaa/agents test
node -e "process.argv=['','','--only','agent-grid'];" # sanity only
pnpm --filter @agripinaa/agents fund --gen --only agent-grid   # prints a plan, sends nothing
```
Expected: typecheck and tests green; `--only` prints a single-wallet plan; an unknown name throws.

- [ ] **Step 7: Commit**

```bash
git add apps/agents/src apps/web/src/lib ops/set-x402-endpoint.sh
git commit -m "agents+web: read agent identity from the shared registry

Every consumer (runner, fund, register, pinned ids, verified records, manifests)
now derives from one record per agent instead of its own hardcoded list. Adding
an agent is one config entry plus a strategy module. Two guards come with it:
the runner refuses to boot a module with no registry record, and register.ts
preflights each manifest URL before minting an identity whose tokenURI would
otherwise 404 forever. fund.ts gains --only so funding a new agent cannot
re-send to funded wallets.

Verified: agents typecheck + tests green; web test + typecheck + build green;
fund --gen --only prints a single-wallet plan and an unknown name throws"
```

---

## Task 12: Automate the execution-proof harvest

**Files:**
- Create: `apps/agents/src/harvest-proofs.ts`
- Create: `apps/agents/tests/harvest-proofs.test.ts`
- Modify: `apps/agents/src/attest.ts` (consume harvested refs)
- Modify: `apps/agents/package.json` (add `"harvest": "tsx src/harvest-proofs.ts"`)

**Interfaces:**
- Produces: `harvestProofs(lines: string[]): HarvestedProof[]` where `HarvestedProof = { slug: string; kind: 'tx' | 'position'; ref: string; at: string; summary: string }`, and a CLI that reads `apps/agents/data/<slug>.log.jsonl`.
- Consumes: agent JSONL logs written by `chassis.ts`.

**Context:** Attestation currently needs someone to read BscScan and paste tx hashes into `attest.ts` and `verified.ts`. With four more agents that is four more manual harvests.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { harvestProofs } from '../src/harvest-proofs';

const lines = [
  JSON.stringify({ event: 'boot', at: '2026-08-24T10:00:00.000Z' }),
  JSON.stringify({
    event: 'swap-settled',
    at: '2026-08-24T10:05:00.000Z',
    txHash: '0x' + 'a'.repeat(64),
    summary: 'WBNB to USDT through Ophis',
  }),
  'not json',
  JSON.stringify({ event: 'tick-error', at: '2026-08-24T10:06:00.000Z' }),
];

test('extracts settled transactions and ignores noise', () => {
  const proofs = harvestProofs(lines);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0]!.kind, 'tx');
  assert.equal(proofs[0]!.ref, '0x' + 'a'.repeat(64));
});

test('malformed lines never throw', () => {
  assert.doesNotThrow(() => harvestProofs(['{', '', 'x']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/agents test`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Parse each line defensively (`try/catch` per line), keep entries carrying a 64-hex `txHash` or a numeric `positionTokenId`, validate the hex shape, sort newest first, and return at most 5 per agent. The CLI reads every `data/<slug>.log.jsonl` for agents in the registry and prints a ready-to-paste `proofs` array plus a suggested `feedbackHash` label.

- [ ] **Step 4: Wire into `attest.ts`**

`attest.ts` calls `harvestProofs` for the agent being attested and uses the newest proof as the `feedbackHash` anchor when no ref is supplied explicitly, keeping the existing explicit-ref path as an override.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agripinaa/agents test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agents/src/harvest-proofs.ts apps/agents/tests/harvest-proofs.test.ts apps/agents/src/attest.ts apps/agents/package.json
git commit -m "agents: harvest execution proofs from the agent logs

Attesting an agent meant reading BscScan by hand and pasting hashes into two
files, which does not scale to eight agents. The harvester reads the JSONL logs
the chassis already writes, validates the hash shapes, and feeds attest.ts
directly; an explicit ref still overrides it.

Verified: agents tests (2 new) pass"
```

---

## Task 13: Second grid agent (`grid-b`)

**Files:**
- Create: `apps/agents/src/agents/grid-b.ts`
- Create: `apps/agents/tests/grid-b.test.ts`
- Modify: `packages/shared/src/agents.ts` (add the record, `tokenId: null` until registered)
- Modify: `apps/agents/src/runner.ts` (add to `ALL`)

**Interfaces:**
- Produces: `gridBAgent: AgentModule` (same shape as `gridAgent`).
- Consumes: the registry record `AGENTS['grid-b']`.

**Context:** Read `apps/agents/src/agents/grid.ts` in full first. `grid-b` is the same strategy with different parameters on a different pair, which is exactly what makes the grid hub a comparison instead of a single listing. Do not copy-paste the whole module if the pure core can be shared: extract the level-ladder and crossing math into a shared helper both modules import, keeping each module's parameters and wiring separate.

- [ ] **Step 1: Read the existing grid agent and its test**

Run: `cat apps/agents/src/agents/grid.ts apps/agents/tests/grid.test.ts`
Note the pure functions that decide levels and crossings, and how `tick` uses the chassis (`ctx.log`, `ctx.breakers`, state).

- [ ] **Step 2: Write the failing test**

Create `apps/agents/tests/grid-b.test.ts` asserting the pure parameter set differs from `grid` in the intended ways and that the ladder math holds:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GRID_B_PARAMS, buildLadder } from '../src/agents/grid-b';

test('grid-b runs a different pair and a wider ladder than grid', () => {
  assert.notEqual(GRID_B_PARAMS.pair, 'WBNB/USDT');
  assert.ok(GRID_B_PARAMS.spacingPct > 1.5, 'wider spacing than grid');
  assert.ok(GRID_B_PARAMS.levelsPerSide >= 4);
});

test('ladder is symmetric around mid and monotonic', () => {
  const ladder = buildLadder(100, GRID_B_PARAMS);
  assert.equal(ladder.buys.length, GRID_B_PARAMS.levelsPerSide);
  assert.equal(ladder.sells.length, GRID_B_PARAMS.levelsPerSide);
  assert.ok(ladder.buys.every((p, i) => i === 0 || p < ladder.buys[i - 1]!));
  assert.ok(ladder.sells.every((p, i) => i === 0 || p > ladder.sells[i - 1]!));
  assert.ok(ladder.buys[0]! < 100 && ladder.sells[0]! > 100);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/agents test`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `grid-b.ts`**

Mirror `grid.ts` structure. Parameters: pair WBNB/USDC (confirm a PancakeSwap V3 pool exists and is deep enough at runtime using the same factory-resolution code `grid.ts` uses; if it is not, fall back to CAKE/WBNB and update the test), `spacingPct: 2.5`, `levelsPerSide: 5`, `clipUsd: 1.5`, `maxTradesPerDay: 8`, cooldown 45 minutes, same trend-breakout and daily-loss halts as `grid.ts`. Every swap routes through Ophis exactly as `grid.ts` does. Reuse the chassis breakers; add no new safety concepts.

- [ ] **Step 5: Add the registry record**

In `packages/shared/src/agents.ts`, add `grid-b` with `tokenId: null`, `managed: false`, `backfillOphisTrades: true`, a manifest body describing the pair and parameters, funding `{ bnb: '0.0015', usdt: '2', wbnb: '0.003' }`, and `registrationTx: null`, `attestation: null`, `proofs: []`.

- [ ] **Step 6: Add to the runner and verify the boot guard**

Add `gridBAgent` to `ALL` in `runner.ts`. Run `pnpm --filter @agripinaa/agents typecheck && pnpm --filter @agripinaa/agents test`.
Expected: PASS. The registry-record guard from Task 11 passes because the record exists.

- [ ] **Step 7: Commit**

```bash
git add apps/agents/src/agents/grid-b.ts apps/agents/tests/grid-b.test.ts apps/agents/src/runner.ts packages/shared/src/agents.ts
git commit -m "agents: second grid agent on a different pair and ladder

One agent per category means a hub is a listing, not a choice. grid-b runs the
same mean-reversion strategy through Ophis with a visibly different
parameterisation (wider spacing, more levels, smaller clips, lower daily cap) on
a second pair, so the grid hub becomes a comparison between two live track
records. Not registered on-chain yet (tokenId null).

Verified: agents tests (2 new) pass; typecheck green"
```

---

## Task 14: Venus health-factor guardian (`venus-guardian`)

**Files:**
- Create: `apps/agents/src/agents/venus-guardian.ts`
- Create: `apps/agents/tests/venus-guardian.test.ts`
- Modify: `packages/shared/src/agents.ts`, `apps/agents/src/runner.ts`

**Interfaces:**
- Produces: `venusGuardianAgent: AgentModule`, `venusHfWad(input: { collateralUsdWad: bigint; borrowUsdWad: bigint; collateralFactorMantissa: bigint }): bigint`.
- Consumes (REUSE, do not reimplement): `planRepair`, `scaleRepayToToken`, `hfWadToNumber`, `classifyHf`, `evaluateThresholds`, `MAX_UINT256`, `WARN_AT`, `ACT_AT`, `TARGET_HF` from `apps/agents/src/agents/health-factor.ts` (all already exported).

**Context:** Read `apps/agents/src/agents/health-factor.ts` (the Aave guardian) first, in full. Its decision logic is pure, bigint, and unit-tested, and it is deliberately protocol-agnostic once you have a 1e18-scaled health factor: `planRepair(hfWad, totalDebtBase, targetHf)` needs nothing Aave-specific. So the ONLY new pure logic here is deriving that health factor from Venus, which reports differently.

Verified on-chain 2026-08-24 (do not re-derive, but do assert these at runtime): Venus Comptroller `0xfD36E2c2a6789Db23113685031d7F16329158384`, oracle `0x6592b5DE802159F3E74B2486b091D11a8256ab8A`, vBNB `0xA07c5b74C9B40447a954e1466938b865b6BBea36` with `collateralFactorMantissa` 0.80e18, vUSDT `0xfD5840Cd36d94D7229439859C0112a4185BC0255` (0.80e18), vUSDC `0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8` (0.825e18). Read the collateral factor from `Comptroller.markets(vToken)` at runtime rather than hardcoding it, since Venus governance can change it. Venus has no Aave-style health-factor call: `getAccountLiquidity` returns `(error, liquidity, shortfall)`, which tells you whether you are underwater but not by what ratio, so the ratio is computed from collateral value, borrow value, and the collateral factor.

Do NOT write a float-based planner. The existing guardian works in base units throughout precisely because float USD math loses precision at repay sizing; matching that idiom is what lets this agent reuse the tested planner instead of shipping a second, weaker one.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_UINT256, planRepair, hfWadToNumber } from '../src/agents/health-factor';
import { venusHfWad } from '../src/agents/venus-guardian';

const WAD = BigInt(10) ** BigInt(18);
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * (BigInt(10) ** BigInt(12));

test('derives a 1e18-scaled health factor from venus values', () => {
  // 160 collateral at 0.8 collateral factor against 100 debt = 1.28
  const hf = venusHfWad({
    collateralUsdWad: usd(160),
    borrowUsdWad: usd(100),
    collateralFactorMantissa: (WAD * BigInt(8)) / BigInt(10),
  });
  assert.ok(Math.abs(hfWadToNumber(hf) - 1.28) < 0.0001, `got ${hfWadToNumber(hf)}`);
});

test('no debt reads as no risk', () => {
  const hf = venusHfWad({
    collateralUsdWad: usd(160),
    borrowUsdWad: BigInt(0),
    collateralFactorMantissa: (WAD * BigInt(8)) / BigInt(10),
  });
  assert.equal(hf, MAX_UINT256);
});

test('feeds the existing repay planner to land on target', () => {
  const collateral = usd(160);
  const debt = usd(100);
  const cf = (WAD * BigInt(8)) / BigInt(10);
  const hf = venusHfWad({ collateralUsdWad: collateral, borrowUsdWad: debt, collateralFactorMantissa: cf });
  const repay = planRepair(hf, debt, 1.6);
  const after = venusHfWad({
    collateralUsdWad: collateral,
    borrowUsdWad: debt - repay,
    collateralFactorMantissa: cf,
  });
  assert.ok(Math.abs(hfWadToNumber(after) - 1.6) < 0.001, `hf after repay ${hfWadToNumber(after)}`);
});

test('an underwater position still produces a bounded repay', () => {
  const debt = usd(100);
  const hf = venusHfWad({
    collateralUsdWad: usd(50),
    borrowUsdWad: debt,
    collateralFactorMantissa: (WAD * BigInt(8)) / BigInt(10),
  });
  const repay = planRepair(hf, debt, 1.6);
  assert.ok(repay > BigInt(0) && repay <= debt, `repay ${repay} out of bounds`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/agents test`
Expected: FAIL, cannot find `../src/agents/venus-guardian`.

- [ ] **Step 3: Implement**

`venusHfWad` returns `MAX_UINT256` when `borrowUsdWad` is zero (matching Aave's no-debt sentinel so `planRepair` short-circuits), else `(collateralUsdWad * collateralFactorMantissa) / borrowUsdWad / WAD`-scaled to 1e18. Keep it pure, integer-only, and free of any network or viem import so it stays unit-testable.

The module then: ticks every 60s; reads the position through the Comptroller and oracle; builds `collateralUsdWad` and `borrowUsdWad` from `vToken.balanceOfUnderlying` / `borrowBalanceCurrent` times the oracle price; calls `venusHfWad`; runs the SAME `evaluateThresholds(prevZone, hf, WARN_AT, ACT_AT)` as the Aave guardian; and on `shouldRepair` repays USDT sized by `planRepair` then `scaleRepayToToken`, capped by the wallet balance exactly as `planRepayAmounts` does. Max 6 repays/day through the existing breakers. Mirror `health-factor.ts` for logging, state, and error handling.

- [ ] **Step 4: Add the registry record and runner entry**

Record: `venus-guardian`, category `health-factor`, `tokenId: null`, funding `{ bnb: '0.0015', usdt: '2', wbnb: '0.005' }`, manifest describing the Venus protection strategy and the same safety fields shape as the Aave guardian.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agripinaa/agents test && pnpm --filter @agripinaa/agents typecheck`
Expected: PASS, 3 new tests.

- [ ] **Step 6: Commit**

```bash
git add apps/agents/src/agents/venus-guardian.ts apps/agents/tests/venus-guardian.test.ts apps/agents/src/runner.ts packages/shared/src/agents.ts
git commit -m "agents: venus liquidation guardian for the health-factor hub

The health-factor category had one agent covering one lending venue, which reads
as a single-protocol demo rather than a category. This one protects a Venus
borrow position on the same repay-to-target logic, with the health measure
derived from collateral, debt, and the market collateral factor (Venus has no
Aave-style health factor call). Venus is BSC-native. Not registered yet.

Verified: agents tests (3 new) pass covering the repay planner at, above, and
below target; typecheck green"
```

---

## Task 15: Portfolio-weight rebalancer (`weight-rebalancer`)

**Files:**
- Create: `apps/agents/src/agents/weight-rebalancer.ts`
- Create: `apps/agents/tests/weight-rebalancer.test.ts`
- Modify: `packages/shared/src/agents.ts`, `apps/agents/src/runner.ts`

**Interfaces:**
- Produces: `weightRebalancerAgent: AgentModule`, `planWeightTrade(input: { baseUsd: number; quoteUsd: number; targetWeight: number; bandPct: number }): { side: 'buy' | 'sell' | 'none'; usd: number }`.

**Context:** Read the inventory-rebalance section of `apps/agents/src/agents/lp-range.ts`, which already computes a 50/50-by-value swap before re-minting. This agent is that logic standing alone, ticking on drift. The rubric's Rebalancing category names "position resets", which this matches directly, and every rebalance mints another Ophis settlement receipt for the proof feed.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planWeightTrade } from '../src/agents/weight-rebalancer';

test('does nothing inside the band', () => {
  const plan = planWeightTrade({ baseUsd: 51, quoteUsd: 49, targetWeight: 0.5, bandPct: 5 });
  assert.equal(plan.side, 'none');
  assert.equal(plan.usd, 0);
});

test('sells the overweight side back to target', () => {
  const plan = planWeightTrade({ baseUsd: 70, quoteUsd: 30, targetWeight: 0.5, bandPct: 5 });
  assert.equal(plan.side, 'sell');
  assert.ok(Math.abs(plan.usd - 20) < 0.001, `expected 20, got ${plan.usd}`);
});

test('buys the underweight side back to target', () => {
  const plan = planWeightTrade({ baseUsd: 30, quoteUsd: 70, targetWeight: 0.5, bandPct: 5 });
  assert.equal(plan.side, 'buy');
  assert.ok(Math.abs(plan.usd - 20) < 0.001, `expected 20, got ${plan.usd}`);
});

test('never plans a trade larger than the side it sells', () => {
  const plan = planWeightTrade({ baseUsd: 100, quoteUsd: 0, targetWeight: 0.5, bandPct: 5 });
  assert.ok(plan.usd <= 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/agents test`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`planWeightTrade` computes `total = baseUsd + quoteUsd`, `weight = baseUsd / total`, returns `none` when `|weight - targetWeight| * 100 <= bandPct`, else the USD amount that restores the target (`|baseUsd - total * targetWeight|`) with side `sell` when overweight base and `buy` when underweight. The module holds WBNB/USDT 50/50, ticks every 10 minutes, uses a 5% band, executes one Ophis swap per rebalance, caps at 4 rebalances/day, and reuses the chassis breakers.

- [ ] **Step 4: Add the registry record and runner entry**

Record: `weight-rebalancer`, category `rebalancing`, `tokenId: null`, funding `{ bnb: '0.0015', usdt: '2.5', wbnb: '0.004' }`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agripinaa/agents test && pnpm --filter @agripinaa/agents typecheck`
Expected: PASS, 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add apps/agents/src/agents/weight-rebalancer.ts apps/agents/tests/weight-rebalancer.test.ts apps/agents/src/runner.ts packages/shared/src/agents.ts
git commit -m "agents: portfolio-weight rebalancer for the rebalancing hub

Second agent in the rebalancing category, and a different idea from the LP range
manager: it holds a 50/50 WBNB/USDT split by value and restores the target with
one Ophis swap when drift leaves a 5 percent band. The drift math is the
inventory-rebalance logic that already sat inside the LP agent, now standing
alone and unit-tested. Not registered yet.

Verified: agents tests (4 new) pass covering in-band, both out-of-band
directions, and the trade-size clamp; typecheck green"
```

---

## Task 16: Conservative managed yield agent (`yield-b`)

**Files:**
- Create: `apps/agents/src/agents/yield-b.ts`
- Create: `apps/agents/tests/yield-b.test.ts`
- Modify: `packages/shared/src/agents.ts`, `apps/agents/src/runner.ts`
- Modify: `apps/web/src/components/ManagedWizard.tsx` and `apps/web/src/app/api/managed/[agent]/*` if either hardcodes the `yield` slug (check with `rg -n "'yield'|\"yield\"" apps/web/src`)

**Interfaces:**
- Produces: `yieldBAgent: AgentModule`, `shouldRotate(input: { currentApyBps: number; rivalApyBps: number; thresholdBps: number; consecutiveWins: number; requiredWins: number }): boolean`.
- Consumes: the existing managed-funds machinery: `buildManagerKeySet`, `tickManagedYield`, `managedExecutor`, `AgripinaaYieldRouter` deployments.

**Context:** This is the marketplace-shaped change: two agents competing for user deposits on the same drain-proof router, with different policies. Read `apps/agents/src/agents/yield.ts`, `apps/agents/src/managed-runner.ts`, and `apps/agents/src/manager-key.ts` first. The router is per-token and un-owned, so a second agent needs no contract change: it needs its own master manager key (`wallets/agent-yield-b-session.json`, generated by `fund --gen --only agent-yield-b-session`) and `managed: true` in its registry record.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldRotate, YIELD_B_PARAMS } from '../src/agents/yield-b';

test('is more conservative than the existing harvester', () => {
  assert.ok(YIELD_B_PARAMS.thresholdBps > 50, 'wider threshold than yield (50 bps)');
  assert.ok(YIELD_B_PARAMS.requiredWins > 2, 'more confirmations than yield (2)');
});

test('holds when the rival lead is inside the threshold', () => {
  assert.equal(
    shouldRotate({ currentApyBps: 200, rivalApyBps: 240, thresholdBps: 100, consecutiveWins: 9, requiredWins: 3 }),
    false,
  );
});

test('holds when the lead is big but unconfirmed', () => {
  assert.equal(
    shouldRotate({ currentApyBps: 200, rivalApyBps: 400, thresholdBps: 100, consecutiveWins: 1, requiredWins: 3 }),
    false,
  );
});

test('rotates on a confirmed lead beyond the threshold', () => {
  assert.equal(
    shouldRotate({ currentApyBps: 200, rivalApyBps: 400, thresholdBps: 100, consecutiveWins: 3, requiredWins: 3 }),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/agents test`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`YIELD_B_PARAMS`: `thresholdBps: 120`, `requiredWins: 3`, tick every 12 hours, max 1 rotation per 2 days. `shouldRotate` returns `rivalApyBps - currentApyBps >= thresholdBps && consecutiveWins >= requiredWins`. The module otherwise mirrors `yield.ts`: same venues (Aave v3, Venus), same measured block-cadence APY read, same router actions, same managed tick entry point.

- [ ] **Step 4: Wire managed mode**

Set `managed: true` on the `yield-b` record. Confirm `runner.ts` derives `MANAGED_AGENTS` from the registry (Task 11), so no list edit is needed. Then check the web side for a hardcoded agent slug in the managed routes and wizard; if the wizard offers only one agent, make it read the managed agents from the registry so a user can choose which agent manages their deposit.

- [ ] **Step 5: Run tests and confirm the second manager identity**

```bash
pnpm --filter @agripinaa/agents test
pnpm --filter @agripinaa/agents typecheck
pnpm --filter @agripinaa/agents fund --gen --only agent-yield-b-session   # generates the key file, sends nothing
```
Expected: tests pass (4 new); the key file exists at `wallets/agent-yield-b-session.json` with mode 600; nothing broadcast.

- [ ] **Step 6: Commit**

```bash
git add apps/agents/src/agents/yield-b.ts apps/agents/tests/yield-b.test.ts apps/agents/src/runner.ts packages/shared/src/agents.ts apps/web/src
git commit -m "agents+web: a second managed agent competing on the same router

Funds under management was a single-agent feature, which makes it a product
demo rather than a marketplace. yield-b runs the same venue rotation on the same
un-owned drain-proof router with a deliberately conservative policy (120 bps
threshold, three confirmations, one rotation per two days) and its own master
manager key, so a depositor picks between two policies with separate track
records. No contract change: the router is per-token and agent-agnostic.

Verified: agents tests (4 new) pass covering threshold and confirmation gates;
typecheck green; manager key generated locally, nothing broadcast"
```

---

## Task 17: Register, fund, and attest the four new agents

**Files:**
- Modify: `packages/shared/src/agents.ts` (fill in `tokenId`, `wallet`, `registrationTx`, `attestation`, `proofs` after each step)
- Uses: `apps/agents/src/{fund,register,attest,harvest-proofs}.ts`

**Context:** This task broadcasts real transactions and spends real funds. **It requires the owner's explicit go-ahead in the session, and their sign-off on the four display names, before any step runs.** Registration target is 2026-09-01 so each agent accumulates a week of visible track record before judging.

- [ ] **Step 1: Confirm names and budget with the owner**

Present the four proposed display names and the funding total (roughly 0.006 BNB plus 8.5 USDT plus 0.012 WBNB across the four agents, from the registry funding fields). Wait for explicit approval. Check the `spike-a` treasury balance and report any shortfall.

- [ ] **Step 2: Generate and fund the wallets**

```bash
pnpm --filter @agripinaa/agents fund --gen --only agent-grid-b,agent-venus-guardian,agent-weight-rebalancer,agent-yield-b,agent-yield-b-session
pnpm --filter @agripinaa/agents fund --execute --only agent-grid-b,agent-venus-guardian,agent-weight-rebalancer,agent-yield-b
```
Expected: four funded wallets, each holding its planned BNB/USDT/WBNB. Record the addresses into the registry records.

- [ ] **Step 3: Deploy the manifests before registering**

```bash
git push origin marketplace-expansion   # or merge, per the owner's preference
```
Wait for the Vercel deployment, then confirm each new manifest resolves:
```bash
for s in grid-b venus-guardian weight-rebalancer yield-b; do
  curl -sf "https://agripinaa.vercel.app/manifests/$s.json" | head -c 120; echo;
done
```
Expected: four JSON bodies. The preflight in `register.ts` enforces this, but check it by hand too: a bad `tokenURI` is permanent.

- [ ] **Step 4: Register on-chain**

```bash
pnpm --filter @agripinaa/agents register --only grid-b,venus-guardian,weight-rebalancer,yield-b
```
Expected: four ERC-8004 identity mints, each from the agent's own wallet. Record `tokenId` and `registrationTx` into the registry records and commit.

- [ ] **Step 5: Let them run, then attest**

Start the runner (locally or on the VM) and let each new agent complete at least one real action. Then:
```bash
pnpm --filter @agripinaa/agents harvest
pnpm --filter @agripinaa/agents attest --only grid-b,venus-guardian,weight-rebalancer,yield-b
```
Expected: four `giveFeedback` transactions from the verifier wallet, each anchored to a harvested execution ref. Record `attestation` and `proofs` into the registry.

- [ ] **Step 6: Verify the marketplace shows eight agents, two per hub**

```bash
for c in grid health-factor yield rebalancing; do
  echo "== $c"; curl -s "https://agripinaa.vercel.app/c/$c" | rg -c 'agp-reveal'
done
```
Expected: at least 2 agent cards per hub.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agents.ts
git commit -m "shared: record on-chain identities for the four new agents

Token ids, wallets, registration and attestation transactions, and the harvested
execution proof for grid-b, venus-guardian, weight-rebalancer, and yield-b.
Every mandated category now holds two live agents with separate track records.

Verified: all four manifests resolve on the deployed site; four identity mints
and four attestations confirmed on BscScan; each category hub renders two or
more agent cards"
```

---

## Production incident, found 2026-08-24 during Phase 1

Diagnosed while Tasks 1 and 2 were running. Both live agents that produce Ophis receipts were broken, which is why the marketplace shows 4 lifetime fills. The runner itself was healthy the whole time (VM up 5 days, all four tick loops logging).

**Grid, starved since 2026-08-19.** `evaluateGuards` rejects with `insufficient-balance` when `balanceBaseUnits < clipBaseUnits`. `CLIP_USD` is 2 and the wallet holds 1.9964 USDT, so it is short by roughly four tenths of a cent. The journal carries **1,559 blocked attempts**. Its WBNB leg (0.0036) is likewise below a $2 sell clip. Nothing is wrong with the code: it is correctly refusing to trade capital it does not have. Fix is capital, or a smaller clip. Both need the owner's decision because both change live trading. Recorded here so Task 18 does not mistake this for a cap problem: raising `maxTradesPerDay` would not have produced a single extra fill.

**Ranger, stuck since 2026-08-22.** Fixed in `b41cdf8` plus its follow-up. It removed liquidity mid-rebalance, never re-minted, and kept range-checking the emptied position because `tick` only revalidated a position on-chain when state had none. All three of its position NFTs read `liquidity 0`. Note the bug's permanence was price-dependent: the stale range happens to contain the current tick, so `inRange` stayed true forever. Had price left that range for 30 minutes, the rebalance branch would have self-cleared. Two older NFTs almost certainly resolved that way, which is why their `tokensOwed` are 0.

**Consequences for later tasks:**
- Task 12 (proof harvest): the Ranger's committed attestation proof points at position #7173629 with the note "managed in range". That position has zero liquidity, so the claim does not survive a click. Refresh the proof refs after the agent mints again.
- Task 17: the treasury cannot fund anything today. `spike-a` holds 1.54 USDT and 0.0004 BNB. Owner top-up of roughly 25 USDT and 0.045 BNB covers the Grid restart, the Ranger, all four new agents, and gas margin for eight agents through 2026-09-23.
- Task 18: the cap raises stay proposed, but they are second-order. Capital and the self-heal are what actually restore a track record.
- A deploy to the VM is required before any of the agent fixes take effect in production. That is a separate, explicit step: `./ops/deploy-aleph.sh agripinaa-aleph` (the script accepts a bare ssh_config alias; the VM is root@46.247.131.210 port 28092), which re-syncs code and restarts the runner while leaving the tunnel running so its URL stays stable. Do not run it as a side effect of a code task.

**RESOLVED 2026-08-24 17:41 CEST.** Deployed at `8314ab3` (the four agent fixes cherry-picked to main; the web work stayed on the branch, so production Vercel is untouched and still serves the old static manifests). Both agents recovered, verified on-chain:

- Ranger, 22 seconds from boot to working: `position-empty` cleared #7209976, the inventory-prep Ophis order filled, and it minted **#7248592**, which reads `liquidity = 2451189888573570005` on-chain against the three older positions still at 0. It has been range-checking the new position normally since.
- Grid filled at 15:45:23 with `desiredClipUsd: 2, effectiveClipUsd: 1.9963839118921194`, its first trade since 2026-08-19 and the one that had been refused 1,559 times.
- The public proof feed went from 9 events (all Ranger, newest 2 days old) to 12 with three timestamped that day across two agents.

Post-recovery state confirms the capital analysis: Grid now holds 0.006379 WBNB and **zero USDT**, so it cannot buy again until its sell leg fills at 730.816 or a re-center re-arms it. One clip per side is the ceiling at this inventory, which is why a top-up should be sent as BNB (the starved sell leg) rather than USDT.

**Also stale and NOT yet fixed:** `ops/launch.md`'s Aleph migration section still instructs `git add apps/agents/data && git commit` to hand off agent state, but `.gitignore` contains `apps/agents/data/`, so that procedure cannot work. State now lives only on the VM. Rewriting the hand-off narrative needs a decision about how state migrates and is not covered by any task in this plan.

---

## Task 18: Track records that read as a working rail

**Files:**
- Create: `apps/web/src/components/TrackRecordPanel.tsx`
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx`
- Modify: `apps/agents/src/agents/*.ts` (raise caps, owner-approved values only)

**Interfaces:**
- Consumes: `@agripinaa/exec-metrics` (`CowOrderbookClient`, `isOphisOrder`, `surplusBps`) and the settlement data already used by `apps/web/src/lib/proof.ts`.
- Produces: `TrackRecordPanel({ wallet, tokenId }): JSX.Element` rendering cumulative fills, average surplus in bps, and realized P&L where computable.

- [ ] **Step 1: Propose the cap changes to the owner**

Current caps: grid 12 trades/day and a 31-minute cooldown; guardian 6 repays/day; harvester 2 enters and 1 rotation/day; ranger 4 rebalances/week plus 2/day. Propose: grid to 18/day with a 20-minute cooldown, ranger to 6/week. Leave every loss-halt, trend-halt, and breaker untouched. Get explicit approval before editing.

- [ ] **Step 2: Build the panel**

Server component that fetches the agent's fulfilled Ophis orders (same client and filters as `getOnchainTradeBackfill` in `proof.ts`), and renders: total fills, average surplus bps, best fill, and first-seen date. Handle the zero-fill case with a plain "No fills yet" line rather than an empty panel.

- [ ] **Step 3: Mount it on first-party agent pages**

Render `TrackRecordPanel` on agent detail pages for agents in the registry (skip for indexed third parties, which have no settlement data), inside the existing `Suspense` pattern.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/agent/56/269703 | rg -o 'fills|surplus' | head -5
kill %1
```
Expected: the panel renders with counts, not placeholders.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/TrackRecordPanel.tsx apps/web/src/app/agent apps/agents/src/agents
git commit -m "web+agents: surface cumulative track record per agent

A judge landing on an agent page saw a couple of proof rows and no cumulative
picture, and this hackathon series has previously scored live performance over a
fixed window. Each first-party agent page now shows total fills, average surplus
against the signed limit, best fill, and first-seen date, all from settlement
data. Activity caps raised modestly (owner-approved) so track records thicken
before judging; every loss and trend halt is unchanged.

Verified: web build green; the panel renders live counts on all eight agent
pages"
```

---

# Phase 3: Claim flow and data quality

## Task 19: Claim verification API

**Files:**
- Create: `apps/web/src/lib/claims.ts`
- Create: `apps/web/src/app/api/claim/route.ts`
- Create: `apps/web/tests/claims.test.ts`

**Interfaces:**
- Produces: `CLAIM_TYPES` (EIP-712 types), `buildClaimMessage(input: ClaimFields): TypedDataDefinition`, `verifyClaim(input: { fields: ClaimFields; signature: `0x${string}`; owner: `0x${string}` }): Promise<boolean>`, `saveClaim`, `getClaim(chainId: number, tokenId: string): Promise<ClaimRecord | null>`.
- `ClaimFields`: `{ chainId: number; tokenId: string; description: string; category: Category | 'other'; website: string; endpoint: string; issuedAt: string }`.
- Consumes: `kvGet`/`kvSet` (Task 1), `IdentityRegistry.ownerOf` via viem, `safeFetchJson` from `@agripinaa/shared/ssrf`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';

import { buildClaimMessage, sanitizeFields, verifyClaimSignature } from '../src/lib/claims';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const fields = {
  chainId: 56,
  tokenId: '297380',
  description: 'A yield agent that rotates between BSC lending venues.',
  category: 'yield' as const,
  website: 'https://example.com',
  endpoint: 'https://agent.example.com/status',
  issuedAt: '2026-08-24T12:00:00.000Z',
};

test('a signature from the owner verifies', async () => {
  const signature = await account.signTypedData(buildClaimMessage(fields));
  assert.equal(await verifyClaimSignature({ fields, signature, owner: account.address }), true);
});

test('a signature from someone else does not verify', async () => {
  const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const signature = await other.signTypedData(buildClaimMessage(fields));
  assert.equal(await verifyClaimSignature({ fields, signature, owner: account.address }), false);
});

test('tampering with a field invalidates the signature', async () => {
  const signature = await account.signTypedData(buildClaimMessage(fields));
  const tampered = { ...fields, description: 'Something else entirely, longer than before.' };
  assert.equal(await verifyClaimSignature({ fields: tampered, signature, owner: account.address }), false);
});

test('field sanitisation caps lengths and rejects non-https urls', () => {
  const dirty = sanitizeFields({
    ...fields,
    description: 'x'.repeat(5_000),
    website: 'javascript:alert(1)',
    endpoint: 'http://insecure.example.com',
  });
  assert.ok(dirty.description.length <= 600);
  assert.equal(dirty.website, '');
  assert.equal(dirty.endpoint, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agripinaa/web test`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `claims.ts`**

EIP-712 domain `{ name: 'Agripinaa', version: '1', chainId }`, primary type `AgentClaim` with the `ClaimFields` members. `verifyClaimSignature` uses viem's `verifyTypedData`. `sanitizeFields` caps description at 600 chars, website and endpoint at 300, strips anything that is not an `https:` URL, and restricts `category` to the four hub slugs or `'other'`. `saveClaim`/`getClaim` store JSON in KV under `agripinaa:claim:<chainId>:<tokenId>`.

- [ ] **Step 4: Implement the route**

`POST /api/claim`: parse body, `sanitizeFields`, read `ownerOf(tokenId)` from the IdentityRegistry with viem, `verifyClaimSignature` against that owner, reject with 401 on mismatch, 400 on malformed input, 503 when KV is unavailable, then `saveClaim` and return the stored record. `GET /api/claim?chainId=56&tokenId=<id>` returns the record or 404. Rate-limit by storing a per-owner timestamp in KV and rejecting more than 5 claims per hour.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @agripinaa/web test`
Expected: PASS, 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/claims.ts apps/web/src/app/api/claim apps/web/tests/claims.test.ts
git commit -m "web: claim verification for third-party agent owners

An indexed ERC-8004 registration has no way for its owner to say what it does,
so 213 of 214 listings render as an id and a dash. Owners can now prove control
with an EIP-712 signature checked against ownerOf, and attach a description,
category, website, and endpoint. Fields are sanitised and capped, non-https urls
are dropped, and claims are rate limited per owner.

Verified: web tests (4 new) pass covering owner signature, wrong signer, tampered
fields, and sanitisation"
```

---

## Task 20: Claim UI

**Files:**
- Create: `apps/web/src/app/agent/[chainId]/[tokenId]/claim/page.tsx`
- Create: `apps/web/src/components/ClaimForm.tsx`
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx` (entry point)

**Interfaces:**
- Consumes: `POST /api/claim`, wagmi's `useAccount`/`useSignTypedData` (wagmi 3.7 is already a dependency), `buildClaimMessage` from `claims.ts`.

- [ ] **Step 1: Build the form**

Client component: connect wallet, show the on-chain owner and whether the connected address matches, then a form for description, category, website, endpoint. On submit, sign the typed message and POST it. Show the three outcomes plainly: stored, "connected wallet is not the owner of this agent", and "claiming from a contract wallet is not supported yet" when the owner address has bytecode (check with `getBytecode`).

- [ ] **Step 2: Add the entry point**

On unclaimed third-party agent pages, add a muted line under the identity panel: "Own this agent? Claim it to add a description, category, and endpoint." linking to the claim page. Never show it for first-party agents or already-claimed ones.

- [ ] **Step 3: Verify the flow renders**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/agent/56/297380/claim | rg -c 'Claim'
curl -s localhost:3000/agent/56/269703 | rg -c 'Own this agent' || echo "correctly absent on first-party"
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/agent apps/web/src/components/ClaimForm.tsx
git commit -m "web: claim-your-agent flow for indexed registrations

The owner of any indexed ERC-8004 agent can now connect, sign, and describe
their agent from its listing page. Contract-wallet owners get a plain notice
rather than a broken signature flow, and the entry point never appears on
first-party or already-claimed listings.

Verified: web build green; claim page renders for a registry agent and the entry
point is absent on first-party pages"
```

---

## Task 21: Merge claims into listings

**Files:**
- Modify: `apps/web/src/lib/data.ts` (`getAgent`, `listAgents`, `listDirectory`)
- Modify: `apps/web/src/components/AgentCard.tsx`, `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx` (provenance label)
- Create: `apps/web/tests/claim-merge.test.ts`

**Interfaces:**
- Produces: `applyClaim(agent: AgentSummary, claim: ClaimRecord | null): AgentSummary` in `apps/web/src/lib/claim-merge.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyClaim } from '../src/lib/claim-merge';

const bare = {
  tokenId: '297380',
  name: 'Agent #297380',
  description: '',
  category: null,
  claimed: false,
} as never;

test('an owner claim fills description and category', () => {
  const merged = applyClaim(bare, {
    fields: { description: 'Rotates lending venues.', category: 'yield' },
  } as never);
  assert.equal(merged.description, 'Rotates lending venues.');
  assert.equal(merged.category, 'yield');
  assert.equal(merged.claimed, true);
});

test('no claim leaves the agent untouched', () => {
  assert.equal(applyClaim(bare, null), bare);
});

test('a claim never overwrites on-chain metadata that already exists', () => {
  const rich = { ...bare, name: 'Real Name', description: 'From tokenURI.', category: 'grid' } as never;
  const merged = applyClaim(rich, { fields: { description: 'Owner text.', category: 'yield' } } as never);
  assert.equal(merged.description, 'From tokenURI.');
  assert.equal(merged.category, 'grid');
});
```

- [ ] **Step 2: Run test to verify it fails, then implement**

Run: `pnpm --filter @agripinaa/web test` (FAIL), then write `claim-merge.ts` so on-chain metadata always wins and claims only fill gaps, setting `claimed: true` whenever a claim exists.

- [ ] **Step 3: Wire into the data layer and UI**

Apply claims in `getAgent` and in the list paths, add `claimed?: boolean` to the summary type in `packages/agent-index/src/types.ts`, and render an "owner-provided" label next to claimed fields (matching the existing `FreshnessStamp` provenance style). Claimed categories now feed the hubs.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web build
git add apps/web/src packages/agent-index/src/types.ts
git commit -m "web: show owner-provided detail on claimed listings

Claims now fill the gaps on indexed agents (description, category, website) and
feed the category hubs, with an owner-provided label so the provenance is never
ambiguous. On-chain metadata always wins where it exists; a claim can only fill
a blank.

Verified: web tests (3 new) pass including the on-chain-wins case; build green"
```

---

## Task 22: Endpoint liveness probes

**Files:**
- Create: `apps/web/src/lib/liveness.ts`
- Create: `apps/web/tests/liveness.test.ts`
- Modify: `apps/web/src/components/AgentCard.tsx` (badge), `apps/web/src/lib/activatable.ts` usage sites (pass the real `endpointLive`)

**Interfaces:**
- Produces: `probeEndpoint(url: string): Promise<{ live: boolean; checkedAt: string; status?: number }>`, `getLiveness(chainId: number, tokenId: string): Promise<LivenessRecord | null>`.
- Consumes: `safeFetchJson` / the SSRF guard in `packages/shared/src/ssrf.ts`, `kvGet`/`kvSet`.

- [ ] **Step 1: Write the failing test**

Cover: a probe of an https URL that resolves (mock `fetch`), a probe that times out returns `live: false` without throwing, and that a non-https or private-host URL is refused before any fetch happens.

- [ ] **Step 2: Implement**

`probeEndpoint` uses the existing SSRF-safe fetch with a 5s timeout, treats any 2xx/3xx/401/402 as live (402 is the x402 paywall answering correctly), stores the result in KV under `agripinaa:liveness:<chainId>:<tokenId>`, and never throws.

- [ ] **Step 3: Surface it**

Add a small "live" badge to `AgentCard` when the stored liveness is fresh (within 24h) and true. Pass the same value into `isActivatable` at the detail and activate pages, so a claimed, responsive third-party agent becomes activatable.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web build
git add apps/web/src/lib/liveness.ts apps/web/tests/liveness.test.ts apps/web/src/components/AgentCard.tsx apps/web/src/app/agent
git commit -m "web: probe claimed agent endpoints and badge the ones that answer

A claimed endpoint is a claim until something answers it. Endpoints are probed
through the existing SSRF guard (x402's 402 counts as answering), the result is
cached with a timestamp, and only a fresh live result unlocks activation for a
third-party agent. Stale results decay rather than lingering as a badge.

Verified: web tests (3 new) pass covering a live probe, a timeout, and refusal
of a private-host url; build green"
```

---

## Task 23: Re-seed and classify the index

**Files:**
- Modify: `packages/agent-index/scripts/seed.ts` (use the keyed API, larger set)
- Modify: `packages/agent-index/src/classify.ts` (broaden keywords, add tests)
- Create: `packages/agent-index/tests/classify.test.ts`
- Create: `apps/web/src/app/api/cron/refresh/route.ts`
- Modify: `apps/web/vercel.json` (create if absent; add the cron schedule)
- Regenerate: `packages/agent-index/data/agents-56.json`

- [ ] **Step 1: Write classifier tests first**

Assert that representative names and descriptions land in the right hub: "grid bot", "DCA grid trader" to `grid`; "liquidation protection", "health factor monitor" to `health-factor`; "APY optimizer", "yield router" to `yield`; "LP range manager", "position rebalancer" to `rebalancing`; and that unrelated text returns `null`. Run and watch them fail where the current keywords are too narrow.

- [ ] **Step 2: Broaden the keyword sets**

Extend the regexes in `classify.ts` until the tests pass. Keep explicit `metadata.category` as the highest-priority signal, and never guess a category for text with no signal (null is correct, and accurate about coverage).

**Calibrate your expectations before you start.** Sampled the live keyed API on 2026-08-24 (`/api/index/agents?limit=20`, source `8004scan-pro`, total **278,592** BSC agents): all 20 returned rows had a name and a description, and **4 of 20 classified, all four of them ours**. The third-party names in that sample were `Novager7yec618du`, `Lang Thang`, `airdropblogspot.agent`, `rohit.agent`. That is airdrop-farming noise, not agents with a strategy to classify. Two consequences:

1. The "Agent #id with no description" problem is mostly a **snapshot** problem, not a live-path problem. Re-seeding fixes the offline fallback tier; the live tier already returns names and descriptions.
2. No keyword classifier can put `rohit.agent` in a category, because there is no signal to read. Do not chase a high classification rate, and do not loosen the regexes until they start guessing. Populated hubs come from our own eight agents plus claimed agents (Task 19-21), and the honest public number is how many agents are classified and probe-live, not what fraction of 278k we labelled.

- [ ] **Step 3: Re-seed with the keyed API**

Update `seed.ts` to use the keyed endpoint (server-side `chain_id` works there), paginate to at least 2,000 BSC agents at a rate under 180 req/min, and write the snapshot. Run `pnpm seed:agents` and record in the commit body how many of the seeded agents classify into a hub.

- [ ] **Step 4: Add the refresh cron**

Route handler that re-runs the seed pipeline into KV, re-probes claimed endpoints, and returns counts. Protect it with the same `OPS_TOKEN` bearer check as `/api/ops/runner-url`, and add a `vercel.json` cron entry hitting it every 6 hours.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @agripinaa/agent-index test
pnpm seed:agents
rg -c '"category":null' packages/agent-index/data/agents-56.json
git add packages/agent-index apps/web/src/app/api/cron apps/web/vercel.json
git commit -m "index: re-seed from the keyed api and classify the long tail

The offline snapshot was 214 agents seeded on 2026-08-07 with 213 of them
unclassified, so every category hub was effectively empty of third parties and
the fallback tier was three weeks stale. Seeding now uses the keyed endpoint
(where the chain filter works), covers a far larger BSC set, and the classifier
keywords are broadened and unit tested. A six-hourly cron refreshes the live
tier and re-probes claimed endpoints.

Verified: agent-index tests pass including new classifier cases; re-seeded
snapshot classifies N of M agents into hubs"
```

---

## Task 24: Search, filters, and pagination

**Files:**
- Create: `apps/web/src/components/AgentFilters.tsx`
- Modify: `apps/web/src/app/agents/page.tsx` (remove `.slice(0, 45)`, add search params)
- Modify: `apps/web/src/lib/data.ts` (accept a search term, thread the cursor)

**Context:** `/agents` hard-caps at 45 cards while `/api/index/agents` already supports a cursor and `searchAgents()` exists in `agent-index` with no UI, so most of the index is unreachable from the site.

- [ ] **Step 1: Read how the page reads search params**

Check the Next 16 docs entry for `searchParams` in Server Components (it is a Promise in this version) before writing.

- [ ] **Step 2: Add the controls**

Search box (debounced, writes `?q=`), category select (`?c=`), and a "live endpoints only" toggle (`?live=1`), all driven through URL search params so the state is shareable and server-rendered.

- [ ] **Step 3: Replace the cap with pagination**

Remove `.slice(0, 45)`, render the current page from `listAgents`, and add a "Load more" link that carries `?cursor=`. Run `rankAndDedupe` over the accumulated set server-side so dedupe spans pages.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s 'localhost:3000/agents?q=grid' | rg -c 'agp-reveal'
curl -s 'localhost:3000/agents?c=yield' | rg -c 'agp-reveal'
kill %1
git add apps/web/src
git commit -m "web: search, filters, and pagination across the index

The directory stopped at 45 cards with no search and no way to page, so most of
what we index could not be reached from the site even though the API already
supported a cursor. Search, category, and live-endpoint filters run through URL
params (shareable, server rendered), and dedupe now spans pages instead of
resetting per fetch.

Verified: filtered and searched listings render server-side; paging past the
first page returns fresh, deduped agents"
```

---

# Phase 4: Public proof surfaces

## Task 25: Public funds page

**Files:**
- Create: `apps/web/src/app/funds/page.tsx`, `apps/web/src/components/RouterPanel.tsx`
- Modify: `apps/web/src/app/layout.tsx` (nav entry)

**Interfaces:**
- Consumes: `ROUTER_DEPLOYMENTS` / `routerFor` from `@agripinaa/shared/contracts`, `readRotationHistory` from `apps/web/src/lib/managed.ts`, viem `readContract` for token balances.

- [ ] **Step 1: Build the page**

For each router deployment (USDT `0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb`, USDC `0xb0817946B5A30A0A2a3dE1B8202749EBEb664630`): address with a BscScan link, deployment date and block, live TVL, and the `Rotated` event history with per-row BscScan links. Then a plain-language security section: three zero-argument entrypoints, every recipient hardcoded to `msg.sender`, delta accounting so donated balances can never be swept, no owner, not upgradeable, plus the fuzzing invariants from `contracts/test/fuzz/RouterFuzz.sol`.

- [ ] **Step 2: Handle the empty and offline cases**

Zero rotations renders "No rotations yet" with the deployment block, never an empty panel. An RPC failure renders the addresses and the security section with a stamped "balances unavailable" note.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/funds | rg -c '0xD18375cA4d786aED27C567E6cF8cC3D1D66fE3eb'
kill %1
git add apps/web/src/app/funds apps/web/src/components/RouterPanel.tsx apps/web/src/app/layout.tsx
git commit -m "web: public page for the managed-funds routers

The drain-proof router is the strongest thing this marketplace has and it was
invisible to anyone who had not already connected a wallet and deposited. Both
deployments are now public: addresses, live TVL, full rotation history from the
Rotated event, and a plain-language account of why a compromised session key
cannot move funds anywhere except back to their owner.

Verified: /funds renders both router addresses, live balances, and rotation
history against BSC mainnet"
```

---

## Task 26: Execution-quality leaderboard

**Files:**
- Create: `apps/web/src/app/leaderboard/page.tsx`
- Create: `apps/web/src/lib/leaderboard.ts`
- Create: `apps/web/tests/leaderboard.test.ts`
- Modify: `apps/web/src/app/layout.tsx` (nav entry)

**Interfaces:**
- Produces: `rankByExecution(rows: ExecutionRow[]): RankedRow[]` where `ExecutionRow = { tokenId: string; name: string; fills: number; avgSurplusBps: number; firstSeen: string }`.
- Consumes: `@agripinaa/exec-metrics`.

**Context:** Every competitor ranks agents on self-reported feedback events. Ranking on settlement-derived execution quality is the one leaderboard they cannot copy, and it feeds the Data Quality criterion.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rankByExecution } from '../src/lib/leaderboard';

const rows = [
  { tokenId: '1', name: 'A', fills: 20, avgSurplusBps: 10, firstSeen: '2026-08-01T00:00:00.000Z' },
  { tokenId: '2', name: 'B', fills: 3, avgSurplusBps: 90, firstSeen: '2026-08-20T00:00:00.000Z' },
  { tokenId: '3', name: 'C', fills: 0, avgSurplusBps: 0, firstSeen: '2026-08-22T00:00:00.000Z' },
];

test('agents with no fills rank last and are labelled', () => {
  const ranked = rankByExecution(rows);
  assert.equal(ranked.at(-1)?.tokenId, '3');
  assert.equal(ranked.at(-1)?.unranked, true);
});

test('a thin sample cannot outrank a deep one on average alone', () => {
  const ranked = rankByExecution(rows);
  assert.equal(ranked[0]?.tokenId, '1');
});

test('ranking is stable for identical inputs', () => {
  assert.deepEqual(rankByExecution(rows), rankByExecution(rows));
});
```

- [ ] **Step 2: Run test to verify it fails, then implement**

Score = `avgSurplusBps * min(1, fills / 10)`, so a 3-fill sample cannot beat a 20-fill record on average alone; zero-fill agents get `unranked: true` and sort last. State this formula on the page itself.

- [ ] **Step 3: Build the page**

Table of first-party agents plus any claimed agent with Ophis receipts: rank, name, category, fills, average surplus, score, first seen. A methodology paragraph naming the formula and its data source (batch-auction settlements, not feedback events).

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @agripinaa/web test && pnpm --filter @agripinaa/web build
git add apps/web/src/app/leaderboard apps/web/src/lib/leaderboard.ts apps/web/tests/leaderboard.test.ts apps/web/src/app/layout.tsx
git commit -m "web: leaderboard ranked on settlement data, not feedback events

Existing agent scores across this ecosystem rank self-reported feedback, which
is cheap to farm. The exec-metrics package already derived execution quality
from batch-auction settlements and nothing surfaced it. The leaderboard ranks on
average surplus discounted by sample depth, so a three-fill agent cannot leapfrog
a twenty-fill record, and the formula is printed on the page.

Verified: web tests (3 new) pass covering unranked agents, sample-depth
discounting, and stability; build green"
```

---

## Task 27: x402 demo interaction

**Files:**
- Create: `apps/web/src/components/X402Demo.tsx`
- Modify: `apps/web/src/app/agent/[chainId]/[tokenId]/page.tsx`

**Context:** The brief names Binance x402 as the payment facilitator for hiring agents. The badge appears on cards today with nothing clickable behind it, while a working paywalled endpoint already runs on the agent host.

- [ ] **Step 1: Build the component**

On first-party agent pages: show the endpoint URL, the price (0.05 USDT), and a "what you get" preview of the status payload shape without paying. A "Fetch live status" button performs the x402 flow against the resolved runner URL. When the runner is unreachable, render the degraded state from Task 1 rather than a spinner that never resolves.

- [ ] **Step 2: Verify and commit**

```bash
pnpm --filter @agripinaa/web build && pnpm --filter @agripinaa/web start &
sleep 6
curl -s localhost:3000/agent/56/269703 | rg -c 'x402'
kill %1
git add apps/web/src/components/X402Demo.tsx apps/web/src/app/agent
git commit -m "web: make the x402 badge something you can actually use

x402 is the payment rail this brief names, and the badge pointed at nothing. The
agent page now shows the paywalled endpoint, its price, and the response shape
before paying, with a button that runs the payment flow against the live runner.
An unreachable runner degrades to a stated offline panel.

Verified: agent page renders the x402 panel; the offline path renders when the
runner base is unreachable"
```

---

# Phase 5: Documentation and positioning

## Task 28: Judge-facing documentation

**Files:**
- Modify: `README.md` (currently create-next-app boilerplate at the web level; repo README needs the architecture)
- Create: `docs/architecture.md`, `docs/security-router.md`
- Modify: any page or doc quoting Ophis fees

- [ ] **Step 1: Write the repo README**

The pitch, the four criteria and how the marketplace answers each, a quickstart, the monorepo layout, and links to the architecture and security docs.

- [ ] **Step 2: Write `docs/architecture.md`**

A diagram (mermaid) covering: browser to Vercel, Vercel to 8004scan / BSC RPC / KV, the agent VM behind the tunnel, the ERC-8004 registries, the routers, and Ophis settlement. Name what runs where.

- [ ] **Step 3: Write `docs/security-router.md`**

The threat model (a fully compromised session key), the zero-argument design, recipient hardcoding, the L-1 delta-accounting fix, the two fuzz invariants and their harness, and the fail-closed session scoping rules. Cite file paths and test names so a reader can check each claim.

- [ ] **Step 4: Update the fee disclosure**

Find every place quoting Ophis fees (`rg -ni "bps|fee" apps/web/src docs README.md`) and update to the post-2026-08-11 schedule: 1 bp base, plus price-improvement capture. Do not restate partner terms beyond what is published.

- [ ] **Step 5: Commit**

```bash
git add README.md docs
git commit -m "docs: architecture, router security, and a real readme

The repo shipped the create-next-app readme, and the router's audit fix and fuzz
invariants existed only in commit messages and test names, so a reviewer had no
way to check the strongest claim this project makes. Adds an architecture
diagram, a security document that cites the tests backing each claim, and
corrects the Ophis fee disclosure to the current schedule.

Verified: every file path and test name referenced in the security doc exists"
```

---

## Task 29: TermiX Agent Advantage Report draft

**Files:**
- Create: `docs/termix-agent-advantage-report.md`

**Context:** The TermiX partner track ($6,000 first prize) stacks with the main prize and mostly requires this document: three tasks compared with and without an agent, at least one trading or security task, measured on time, cost, and quality, with the actual outputs attached. The owner reviews before submission.

- [ ] **Step 1: Pick three tasks with data we already have**

Candidates: (a) grid trading a WBNB/USDT ladder for a week, agent versus manual, using real fill data and surplus bps; (b) keeping a lending position above a health-factor floor during a volatile window, using the liquidation-drill repay; (c) rotating stablecoin yield between Aave and Venus, agent versus a static supply, using rotation history and measured APYs.

- [ ] **Step 2: Write it with measured numbers only**

Every figure traceable to a settlement receipt, a BscScan transaction, or an on-chain read. Where a manual baseline cannot be measured, say what was assumed and why, rather than inventing a comparison.

- [ ] **Step 3: Commit and hand to the owner**

```bash
git add docs/termix-agent-advantage-report.md
git commit -m "docs: draft agent advantage report for the termix track

Three tasks compared with and without an agent (grid execution, liquidation
protection, stablecoin yield rotation), measured on time, cost, and quality from
settlement receipts and on-chain reads. Assumptions are stated wherever a manual
baseline could not be measured. Draft for owner review before submission.

Verified: every figure traces to a linked transaction or receipt"
```

---

## Self-Review Notes

Checked against the spec on 2026-08-24:

- Spec section 1 (harden) maps to Tasks 1-9; section 2 (scaffold + agents) to Tasks 10-18; section 3 (claim) to Tasks 19-22; section 4 (data quality and discovery) to Tasks 22-24; section 5 (show the money) to Tasks 25-27; section 6 (docs and positioning) to Tasks 28-29.
- The spec's self-healing tunnel is implemented across Tasks 1, 3, and 4, with the Tailscale Funnel permanent-hostname route documented in Task 4 Step 5 as the preferred operator setup.
- Naming is consistent across tasks: `runnerBase`/`runnerUrl` (Tasks 1, 2, 3, 27), `isSafeRunnerUrl` (Tasks 1, 4), `mergeAttestation`/`withOnchainAttestation` (Task 7), `isActivatable` (Tasks 8, 22), `AGENT_LIST`/`agentBySlug` (Tasks 10-17), `applyClaim` (Task 21), `probeEndpoint` (Task 22), `rankByExecution` (Task 26).
- On-chain broadcasts are confined to Task 17, which is explicitly gated on the owner's go-ahead and name sign-off. Cap changes (Task 18) are likewise gated.
- `chainScoped` is added to `IndexStats` in Task 5 and consumed in the same task; `claimed` is added to the summary type in Task 21 and consumed there and in Task 22.
