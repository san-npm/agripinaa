import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  isDebtCompleteRouter,
  isDebtCompleteRouterRuntime,
  ROUTER_ACTIONS,
  TOKENS_BSC,
  managedStrategyFor,
  routerByAddress,
  toBaseUnits,
} from '@agripinaa/shared';
import { deserializeSession } from '@agripinaa/session-kit/persist';
import { MANAGED_NATIVE_CAP, MANAGED_STABLE_CAP, MAX_SESSION_SECONDS } from '@agripinaa/session-kit/scope';
import {
  isAccountSessionDescriptorValid,
  isSessionKeyValid,
  type ExpectedAccountSessionPermissions,
} from '@agripinaa/session-kit/verify';
import { createX402Merchant } from '@altananetwork/x402-server';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { collectProofEvents } from './proof';
import { RequestGate } from './request-gate';
import {
  loadManaged,
  managedAccountStateKey,
  managedHealthKey,
  MANAGED_HEALTH_MAX_AGE_MS,
  upsertManaged,
  type ManagedAccount,
  type ManagedHealth,
} from './managed';
import { isGlobalHalt, type AgentContext, type AgentModule } from './types';

/** Public identity of an agent's manager session key (private half stays on the VM). */
export interface ManagerIdentity {
  publicKey: Hex;
  address: Hex;
}

/**
 * The public manager identities for one agent: the master (primary token) plus
 * one distinct identity per additional managed token. A session for a given
 * token must be granted to that token's identity, so the two tokens never share
 * an on-chain key (and therefore never share expiry or revocation).
 */
export interface ManagerSet {
  master: ManagerIdentity;
  byToken: Map<string, ManagerIdentity>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ROUTER_SIGNATURE_LIST = Object.values(ROUTER_ACTIONS).map((a) => a.signature);
const manageGate = new RequestGate(20, 60_000, 8);
const SESSION_EXPIRY_CLOCK_SKEW_SECONDS = 5 * 60;

export function managedServiceHalt(
  agent: string,
  account: Hex,
  ctx: AgentContext,
): { halted: boolean; reason?: string } {
  const baseHalt = ctx.breakers.isHalted();
  if (!managedStrategyFor(agent) || isGlobalHalt(baseHalt)) return baseHalt;
  const accountHalt = ctx.state.get<{ reason: string } | null>(
    managedAccountStateKey(account, 'halted'),
    null,
  );
  return accountHalt
    ? { halted: true, reason: accountHalt.reason }
    : { halted: false };
}

export function managedExpiryProblem(expiry: unknown, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  if (typeof expiry !== 'number' || !Number.isInteger(expiry) || expiry <= nowSeconds) {
    return 'session is missing or already expired';
  }
  if (expiry > nowSeconds + MAX_SESSION_SECONDS + SESSION_EXPIRY_CLOCK_SKEW_SECONDS) {
    return 'session expiry exceeds the 30-day managed-session limit';
  }
  return null;
}

function canonicalManagedPermissions(
  router: NonNullable<ReturnType<typeof routerByAddress>>,
): ExpectedAccountSessionPermissions {
  return {
    calls: ROUTER_SIGNATURE_LIST.map((signature) => ({ to: router.address, signature })),
    spend: [
      {
        token: router.usdt,
        period: 'day',
        limit: toBaseUnits(MANAGED_STABLE_CAP, TOKENS_BSC[router.symbol]!.decimals),
      },
      { period: 'day', limit: toBaseUnits(MANAGED_NATIVE_CAP, 18) },
    ],
  };
}

export function canonicalStrategyPermissions(agent: string): ExpectedAccountSessionPermissions | undefined {
  const strategy = managedStrategyFor(agent);
  if (!strategy) return undefined;
  return {
    calls: strategy.callScopes.flatMap((scope) =>
      scope.signatures.map((signature) => ({ to: scope.to, signature })),
    ),
    spend: [
      {
        token: TOKENS_BSC.USDT!.address,
        period: 'day',
        limit: toBaseUnits(MANAGED_STABLE_CAP, TOKENS_BSC.USDT!.decimals),
      },
      ...strategy.additionalSpendCaps.map(({ token, amount }) => ({
        token: TOKENS_BSC[token]!.address,
        period: 'day' as const,
        limit: toBaseUnits(amount, TOKENS_BSC[token]!.decimals),
      })),
      { period: 'day', limit: toBaseUnits(MANAGED_NATIVE_CAP, 18) },
    ],
    signatureCheckers: strategy.signatureCheckers,
  };
}

function canonicalPermissionsFor(
  agent: string,
  chainId: number,
  firstTarget: string,
): { permissions: ExpectedAccountSessionPermissions; managerToken: string; target: Hex } | undefined {
  const strategyPermissions = canonicalStrategyPermissions(agent);
  const strategy = managedStrategyFor(agent);
  if (strategyPermissions && strategy && chainId === 56) {
    const target = strategy.callScopes[0]?.to;
    if (!target || target.toLowerCase() !== firstTarget.toLowerCase()) return undefined;
    return { permissions: strategyPermissions, managerToken: 'USDT', target };
  }
  const router = routerByAddress(firstTarget);
  if (!router || router.chainId !== chainId || !isDebtCompleteRouter(router)) return undefined;
  return { permissions: canonicalManagedPermissions(router), managerToken: router.symbol, target: router.address };
}

function requestIdentity(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const cloudflareIp = req.headers['cf-connecting-ip'];
  const fromLocalTunnel = remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';
  if (fromLocalTunnel && typeof cloudflareIp === 'string' && cloudflareIp.length <= 64) return cloudflareIp;
  return remote;
}

function firstScopedTarget(entry: ManagedAccount): Hex | undefined {
  const first = entry.session.permissions.calls?.[0];
  const target = first && 'to' in first ? first.to : undefined;
  return typeof target === 'string' && ADDRESS_RE.test(target) ? target as Hex : undefined;
}

/**
 * Rebuild, rather than trust, the public session record accepted by /manage.
 * The endpoint is intentionally public, so every stored byte must be derived
 * from audited policy plus the account's exact on-chain key descriptor and
 * permission maps. Unknown permission kinds can otherwise replace a working
 * record and make the SDK's relay encoder throw on every sweep.
 */
export function canonicalManagedSession(
  account: Hex,
  expiry: number,
  router: NonNullable<ReturnType<typeof routerByAddress>>,
  managerPublicKey: Hex,
): ManagedAccount['session'] {
  return {
    walletAddress: account,
    publicKey: managerPublicKey,
    permissions: canonicalManagedPermissions(router),
    expiry,
  };
}

function canonicalSessionFor(
  account: Hex,
  expiry: number,
  permissions: ExpectedAccountSessionPermissions,
  managerPublicKey: Hex,
): ManagedAccount['session'] {
  // ERC-1271 checker approvals are account-local authority verified beside the
  // session descriptor, not an SDK SessionPermissions member. Never persist
  // them inside the session object handed to execute().
  return {
    walletAddress: account,
    publicKey: managerPublicKey,
    permissions: { calls: permissions.calls, spend: permissions.spend },
    expiry,
  };
}

/**
 * Reject any manage request that isn't a real, on-chain, router-scoped session
 * granted to our own manager key. Returns a human-readable problem, or null if
 * the request is safe to store. The security does not rest on this check (the
 * router is drain-proof regardless), but it keeps the registry to sessions we
 * can actually act on and that can only touch the router.
 */
async function validateManageRequest(
  agent: string,
  body: { account?: string; chainId?: number; session?: ManagedAccount['session'] },
  managerSet: ManagerSet,
  attestationClient?: Parameters<typeof isDebtCompleteRouterRuntime>[0],
): Promise<string | null> {
  const { account, chainId, session } = body;
  if (typeof account !== 'string' || !ADDRESS_RE.test(account)) return 'account is not a 20-byte address';
  if (chainId !== 56 && chainId !== 97) return 'chainId must be 56 or 97';
  if (!session || typeof session !== 'object') return 'missing session';
  if (typeof session.walletAddress !== 'string' || session.walletAddress.toLowerCase() !== account.toLowerCase())
    return 'session.walletAddress must equal account';
  if (typeof session.publicKey !== 'string') return 'session is missing a public key';
  const expiryProblem = managedExpiryProblem(session.expiry);
  if (expiryProblem) return expiryProblem;

  const calls = session.permissions?.calls ?? [];
  if (calls.length === 0) return 'session has no scoped calls (would be unrestricted)';
  const firstTo = 'to' in calls[0]! ? calls[0]!.to : undefined;
  const canonical = firstTo ? canonicalPermissionsFor(agent, chainId, firstTo) : undefined;
  if (!canonical) return 'session is not scoped to this agent\'s canonical managed policy';
  const router = routerByAddress(firstTo ?? '');
  if (router && (!attestationClient || !await isDebtCompleteRouterRuntime(attestationClient, router)))
    return 'managed router runtime does not match the audited deployment manifest';
  const expectedCalls = canonical.permissions.calls;
  if (calls.length !== expectedCalls.length) return 'session call count is not the canonical agent policy';
  for (const [index, call] of calls.entries()) {
    const to = 'to' in call ? call.to : undefined;
    const signature = 'signature' in call ? call.signature : undefined;
    const expectedCall = expectedCalls[index];
    if (!expectedCall || !to || to.toLowerCase() !== expectedCall.to.toLowerCase())
      return 'session scopes a call to a non-policy target';
    if (!signature || signature !== expectedCall.signature)
      return 'session scopes a non-policy selector or uses a non-canonical order';
  }

  // The session must be granted to the manager key for the token it manages —
  // never any other token's key. This binds the (token → key identity) mapping
  // so a USDC mandate can't be authorized against the USDT key or vice versa.
  const expected = managerSet.byToken.get(canonical.managerToken);
  if (!expected || session.publicKey.toLowerCase() !== expected.publicKey.toLowerCase())
    return `session is not granted to this agent's ${canonical.managerToken} manager key`;

  // Permissions are canonical rather than client-selected. Together with the
  // account-local expiry/identity read below, this makes the stored record
  // reconstructible from on-chain facts and prevents a third party from
  // replacing it with forged permission bytes for the same public manager key.
  const spend = session.permissions?.spend ?? [];
  if (spend.length !== canonical.permissions.spend.length) {
    return 'session spend-cap count is not the canonical managed policy';
  }
  for (const [index, actual] of spend.entries()) {
    const expectedSpend = canonical.permissions.spend[index];
    if (!actual || !expectedSpend) return 'session spend caps are not the canonical managed policy';
    const actualToken = 'token' in actual ? actual.token?.toLowerCase() : undefined;
    const expectedToken = expectedSpend.token?.toLowerCase();
    if (
      actualToken !== expectedToken
      || actual.period !== expectedSpend.period
      || actual.limit !== expectedSpend.limit
    ) return 'session spend caps are not the canonical managed policy';
  }

  const live = await isSessionKeyValid({
    chainId,
    account: account as Hex,
    sessionPublicKey: session.publicKey as Hex,
  });
  if (!live) return 'session key is not registered/valid on-chain for this account';
  const descriptor = await isAccountSessionDescriptorValid({
    chainId,
    account: account as Hex,
    sessionPublicKey: session.publicKey as Hex,
    sessionAddress: expected.address,
    expiry: session.expiry,
    permissions: canonical.permissions,
  });
  if (!descriptor) return 'session identity, expiry, or permissions do not match the smart account authorization';
  return null;
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 0.05 USDT per status call. */
const PRICE = toBaseUnits('0.05', TOKENS_BSC.USDT!.decimals);

/**
 * One HTTP server for all agents: GET /:agent/status behind an x402
 * permit2-exact paywall (USDT on BSC), plus the public GET /proof feed. The
 * facilitator key broadcasts settlements and pays gas; payTo is each agent's
 * own wallet.
 */
export function startX402Server(opts: {
  port: number;
  facilitatorKey: `0x${string}`;
  agents: Map<string, { module: AgentModule; ctx: AgentContext }>;
  /** Public manager-key identities per managed-capable agent (e.g. yield). */
  managers?: Map<string, ManagerSet>;
  rpcUrl?: string;
}): Server {
  const facilitator = privateKeyToAccount(opts.facilitatorKey);
  const managers = opts.managers ?? new Map<string, ManagerSet>();

  const merchants = new Map(
    [...opts.agents.entries()].map(([name, { ctx }]) => [
      name,
      createX402Merchant({
        chainId: 56,
        chain: bsc,
        rpcUrl: opts.rpcUrl ?? 'https://bsc-rpc.publicnode.com',
        payTo: ctx.account.address,
        price: PRICE,
        rails: [
          {
            rail: 'permit2-exact',
            token: {
              address: TOKENS_BSC.USDT!.address,
              name: 'Tether USD',
              version: '1',
              symbol: 'USDT',
              decimals: TOKENS_BSC.USDT!.decimals,
            },
            spender: facilitator.address,
          },
        ],
        facilitator,
        description: `Agripinaa ${name} agent: live status`,
      }),
    ]),
  );

  let proofCache: { expiresAt: number; value: Promise<Awaited<ReturnType<typeof collectProofEvents>>> } | null = null;
  const getProofEvents = () => {
    const now = Date.now();
    if (proofCache && proofCache.expiresAt > now) return proofCache.value;
    const entry = {
      // Keep concurrent requests coalesced for the entire in-flight scan. The
      // normal 15-second freshness window starts only after it settles.
      expiresAt: Number.POSITIVE_INFINITY,
      value: collectProofEvents([...opts.agents.keys()], 40),
    };
    proofCache = entry;
    void entry.value.then(
      () => {
        if (proofCache === entry) entry.expiresAt = Date.now() + 15_000;
      },
      () => {
        if (proofCache === entry) proofCache = null;
      },
    );
    return entry.value;
  };

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const match = /^\/([a-z-]+)\/status$/.exec(pathname);
    const entry = match ? opts.agents.get(match[1]!) : undefined;
    const merchant = match ? merchants.get(match[1]!) : undefined;

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: [...opts.agents.keys()] }));
      return;
    }
    if (pathname === '/proof') {
      if (req.method !== 'GET') {
        res.writeHead(405, {
          allow: 'GET',
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      try {
        const events = await getProofEvents();
        res.writeHead(200, {
          'cache-control': 'public, max-age=15, stale-while-revalidate=30',
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ events, asOf: new Date().toISOString() }));
      } catch {
        proofCache = null;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'proof feed unavailable' }));
      }
      return;
    }
    // GET /:agent/manager-key — the agent's public session key. The browser
    // grants a router-scoped session to THIS key (via a verify-only stub) so
    // the agent can manage the user's funds without the private key ever
    // leaving the VM.
    const keyMatch = /^\/([a-z-]+)\/manager-key$/.exec(pathname);
    if (keyMatch) {
      const agent = keyMatch[1]!;
      const managerSet = managers.get(agent);
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (!managerSet) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent does not support managed mode' }));
        return;
      }
      // Return the identity for the requested token (default: master/primary).
      // Each token has its own key, so a USDC grant never shares the USDT key.
      const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
      const identity = token ? managerSet.byToken.get(token) : managerSet.master;
      if (!identity) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `agent does not manage token ${token}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agent, token: token ?? null, publicKey: identity.publicKey, address: identity.address }));
      return;
    }

    // Public liveness/registration fact used by the owner's dashboard. It
    // discloses no session bytes: only whether this exact account/router is in
    // the registry and whether the responding runner is halted.
    const serviceMatch = /^\/([a-z-]+)\/managed-status$/.exec(pathname);
    if (serviceMatch) {
      const agent = serviceMatch[1]!;
      const managerSet = managers.get(agent);
      const runtime = opts.agents.get(agent);
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (!managerSet || !runtime) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent does not support managed mode' }));
        return;
      }
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const account = query.get('account') ?? '';
      const targetAddress = query.get('target') ?? query.get('router') ?? '';
      if (!ADDRESS_RE.test(account) || !ADDRESS_RE.test(targetAddress)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'account and target must be 20-byte addresses' }));
        return;
      }
      const registeredEntry = loadManaged(agent).find((candidate) => {
        if (candidate.account.toLowerCase() !== account.toLowerCase()) return false;
        return firstScopedTarget(candidate)?.toLowerCase() === targetAddress.toLowerCase();
      });
      const registered = registeredEntry != null;
      const halted = managedServiceHalt(agent, account as Hex, runtime.ctx);
      const health = registered
        ? runtime.ctx.state.get<ManagedHealth | null>(
            managedHealthKey(account as Hex, targetAddress as Hex),
            null,
          )
        : null;
      const fresh = health != null && Date.now() - health.at <= MANAGED_HEALTH_MAX_AGE_MS;
      const ready = registered && fresh && health?.result === 'ready';
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        registered,
        service: !registered ? 'not-registered' : halted.halted ? 'halted' : ready ? 'ready' : 'unavailable',
        reason: !registered
          ? null
          : halted.reason ?? (!fresh ? 'managed sweep heartbeat is stale or not yet available' : health?.reason ?? null),
        lastSweepAt: health?.at ?? null,
      }));
      return;
    }

    // POST /:agent/manage — register a user account for the agent to manage.
    // No shared secret: the session is the authorization, and we verify on
    // chain that it is real, granted to OUR manager key, unexpired/unrevoked,
    // and scoped to nothing but this chain's drain-proof router selectors.
    const manageMatch = /^\/([a-z-]+)\/manage$/.exec(pathname);
    if (manageMatch) {
      const agent = manageMatch[1]!;
      const managerSet = managers.get(agent);
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (!managerSet) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent does not support managed mode' }));
        return;
      }
      const permit = manageGate.enter(requestIdentity(req));
      if (!permit.ok) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(permit.retryAfterSeconds),
        });
        res.end(JSON.stringify({ error: 'too many managed-session validations' }));
        return;
      }
      try {
        const body = deserializeSession(await readBody(req)) as {
          account?: string;
          chainId?: number;
          session?: ManagedAccount['session'];
        };
        const runtime = opts.agents.get(agent);
        const problem = await validateManageRequest(
          agent,
          body,
          managerSet,
          runtime ? {
            getCode: ({ address }) => runtime.ctx.publicClient.getCode({ address }),
            readContract: (args) => runtime.ctx.publicClient.readContract(args),
          } : undefined,
        );
        if (problem) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: problem }));
          return;
        }
        const session = body.session!;
        const firstCall = session.permissions.calls![0]!;
        const firstTarget = 'to' in firstCall ? firstCall.to : '';
        const canonical = canonicalPermissionsFor(agent, body.chainId!, firstTarget);
        const expectedManager = canonical ? managerSet.byToken.get(canonical.managerToken) : undefined;
        if (!canonical || !expectedManager) throw new Error('validated managed session could not be canonicalized');
        const entry: ManagedAccount = {
          account: body.account as Hex,
          chainId: body.chainId!,
          session: canonicalSessionFor(
            body.account as Hex,
            session.expiry,
            canonical.permissions,
            expectedManager.publicKey,
          ),
          registeredAt: new Date().toISOString(),
        };
        const existingAuthorization = loadManaged(agent).find((candidate) => {
          if (candidate.account.toLowerCase() !== entry.account.toLowerCase()) return false;
          return firstScopedTarget(candidate)?.toLowerCase() === canonical.target.toLowerCase()
            && candidate.session.publicKey.toLowerCase() === entry.session.publicKey.toLowerCase()
            && candidate.session.expiry === entry.session.expiry;
        });
        const all = upsertManaged(agent, entry);
        if (runtime && !existingAuthorization) {
          // A previous grant for the same account/router may have a fresh
          // heartbeat. A replacement mandate is unavailable until this exact
          // new record survives its first sweep.
          runtime.ctx.state.set(managedHealthKey(entry.account, canonical.target), null);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          account: entry.account,
          managedCount: all.length,
        }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }));
      } finally {
        permit.release();
      }
      return;
    }

    if (!entry || !merchant) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown agent' }));
      return;
    }

    try {
      const result = await merchant.requirePayment(
        (req.headers['x-payment'] as string | undefined) ?? null,
      );
      if (result.status === 402) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
        return;
      }
      // Payment has settled on-chain. From here the buyer MUST get a 200: a
      // 500 would mean they paid and got nothing. If status() fails, return
      // the receipt with a null status rather than erroring.
      let status: Record<string, unknown> | null = null;
      try {
        status = await entry.module.status(entry.ctx);
      } catch {
        status = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          agent: entry.module.name,
          category: entry.module.category,
          paidBy: result.receipt.payer,
          settlementTx: result.receipt.txHash,
          status,
        }),
      );
    } catch {
      // Pre-settlement failure (challenge/verify path): no charge occurred.
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });

  server.listen(opts.port);
  return server;
}
