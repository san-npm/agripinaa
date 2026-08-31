import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  isDebtCompleteRouter,
  isDebtCompleteRouterRuntime,
  ROUTER_ACTIONS,
  TOKENS_BSC,
  ALTANA_ORCHESTRATOR_BSC,
  FUNDING_FEE_PAYER_BSC,
  managedStrategyFor,
  routerByAddress,
  toBaseUnits,
  type FundingAsset,
  type RetiredManagerGrant,
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
import {
  createFundingMerchant,
  fundingRequestAccount,
  fundingQuote,
  parseFundingAsset,
  prepareFundingFeePayer,
  type FundingQuoteResponse,
} from './funding-merchant';
import { RequestGate } from './request-gate';
import { retiredManagerConflict } from './retired-manager-grant';
import {
  loadManaged,
  managedAccountStateKey,
  managedHealthKey,
  managedRangerTokenId,
  MANAGED_HEALTH_MAX_AGE_MS,
  removeManagedEntry,
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
  retired?: readonly RetiredManagerGrant[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ROUTER_SIGNATURE_LIST = Object.values(ROUTER_ACTIONS).map((a) => a.signature);
const manageGate = new RequestGate(20, 60_000, 8);
const FUNDING_MERCHANT_GLOBAL_KEY = 'public-funding-merchant';
const fundingMerchantIngressGate = new RequestGate(10_000, 60_000, 16);
// Quote calls normally arrive through one web-server egress address, so this
// is intentionally a generous global abuse ceiling rather than a misleading
// per-user limit. At four polls/minute it supports 2,500 simultaneous tabs;
// the separate concurrency cap still bounds live RPC work during an attack.
const FUNDING_QUOTE_GLOBAL_KEY = 'public-funding-quotes';
const fundingQuoteGate = new RequestGate(10_000, 60_000, 16);
const sessionGrantGate = new RequestGate(1_000, 60_000, 32, 1);
const FUNDING_MERCHANT_BODY_BYTES = 256 * 1024;
const FUNDING_QUOTE_CACHE_MS = 10_000;
const SESSION_EXPIRY_CLOCK_SKEW_SECONDS = 5 * 60;
const SESSION_GRANT_LEASE_MS = 30_000;
const SESSION_GRANT_BODY_BYTES = 4_096;
const PUBLIC_KEY_RE = /^0x04[0-9a-fA-F]{128}$/;
const LEASE_TOKEN_RE = /^0x[0-9a-fA-F]{64}$/;

function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!header?.startsWith('Bearer ') || !expected) return false;
  const presented = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

function managerTokenFor(managerSet: ManagerSet, publicKey: string): string | undefined {
  const normalized = publicKey.toLowerCase();
  for (const [token, identity] of managerSet.byToken) {
    if (identity.publicKey.toLowerCase() === normalized) return token;
  }
  return undefined;
}

export function fundingRoutesEnabled(facilitatorAddress: string, hasQuoteClient: boolean): boolean {
  return hasQuoteClient
    && facilitatorAddress.toLowerCase() === FUNDING_FEE_PAYER_BSC.toLowerCase();
}

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
    ...(router.chainId === 56 ? { relayOrchestrator: ALTANA_ORCHESTRATOR_BSC } : {}),
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
    relayOrchestrator: ALTANA_ORCHESTRATOR_BSC,
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
 * A revocation can confirm between runner sweeps. Reconcile the exact stale
 * registry entry here so the immediately following replacement grant is not
 * rejected until the next sweep; a still-live old key continues to block it.
 */
export async function livePersistedManagerConflict(input: {
  agent: string;
  account: string;
  publicKey: string;
  managerToken: string;
  managerSet: ManagerSet;
  nowSeconds?: number;
}, deps: {
  load?: typeof loadManaged;
  remove?: typeof removeManagedEntry;
  isValid?: typeof isSessionKeyValid;
} = {}): Promise<boolean> {
  const load = deps.load ?? loadManaged;
  const remove = deps.remove ?? removeManagedEntry;
  const isValid = deps.isValid ?? isSessionKeyValid;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const candidates = load(input.agent).filter((candidate) => {
    if (
      candidate.account.toLowerCase() !== input.account
      || candidate.session.expiry <= nowSeconds
      || candidate.session.publicKey.toLowerCase() === input.publicKey
    ) return false;
    const target = firstScopedTarget(candidate);
    const priorToken = managerTokenFor(input.managerSet, candidate.session.publicKey)
      ?? (target
        ? canonicalPermissionsFor(input.agent, candidate.chainId, target)?.managerToken
        : undefined);
    return priorToken === undefined || priorToken === input.managerToken;
  });
  for (const candidate of candidates) {
    const live = await isValid({
      chainId: candidate.chainId,
      account: candidate.account,
      sessionPublicKey: candidate.session.publicKey,
    });
    if (live) return true;
    remove(input.agent, candidate);
  }
  return false;
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
  return canonicalSessionFor(
    account,
    expiry,
    canonicalManagedPermissions(router),
    managerPublicKey,
  );
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

export async function readBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (error: Error, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy && !req.destroyed) req.destroy();
      reject(error);
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        fail(new Error('body too large'), true);
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(
      () => fail(new Error('body read timed out'), true),
      timeoutMs,
    );
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
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
  /** Shared secret for web-to-runner operational endpoints. */
  opsToken?: string;
  rpcUrl?: string;
}): Server {
  const facilitator = privateKeyToAccount(opts.facilitatorKey);
  const managers = opts.managers ?? new Map<string, ManagerSet>();
  const grantLeases = new Map<string, { token: string; expiresAt: number }>();
  const quoteClient = opts.agents.values().next().value?.ctx.publicClient;
  // A locally generated facilitator still serves status/proof/x402 traffic.
  // The public funding routes are enabled only when the runner has both a live
  // quorum client and the key for the fee-payer identity published to clients.
  const fundingMerchant = quoteClient
    && fundingRoutesEnabled(facilitator.address, true)
    ? createFundingMerchant({ client: quoteClient, privateKey: opts.facilitatorKey })
    : null;
  let fundingFeePayerReady: Promise<void> | null = null;
  const fundingQuoteCache = new Map<
    FundingAsset,
    { expiresAt: number; value: Promise<FundingQuoteResponse> }
  >();
  const getFundingQuote = (asset: FundingAsset) => {
    if (!quoteClient) return Promise.reject(new Error('funding quote client unavailable'));
    const now = Date.now();
    const cached = fundingQuoteCache.get(asset);
    if (cached && cached.expiresAt > now) return cached.value;
    const entry = {
      // Coalesce every request for one asset while its quorum reads are in
      // flight. Successful quotes remain reusable for only ten of their
      // thirty valid seconds, leaving the browser ample submission time.
      expiresAt: Number.POSITIVE_INFINITY,
      value: fundingQuote(quoteClient, asset),
    };
    fundingQuoteCache.set(asset, entry);
    void entry.value.then(
      (quote) => {
        if (fundingQuoteCache.get(asset) === entry) {
          // Never serve a cached quote during its final five seconds. Slow RPC
          // responses therefore shorten (or skip) the cache window instead of
          // handing the browser an already stale amount.
          entry.expiresAt = Math.min(
            Date.now() + FUNDING_QUOTE_CACHE_MS,
            quote.expiresAt - 5_000,
          );
        }
      },
      () => {
        if (fundingQuoteCache.get(asset) === entry) fundingQuoteCache.delete(asset);
      },
    );
    return entry.value;
  };

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

    if (pathname === '/internal/session-grant-lease') {
      if (!opts.opsToken) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'activation lease is not configured' }));
        return;
      }
      const authorization = Array.isArray(req.headers.authorization)
        ? undefined
        : req.headers.authorization;
      if (!bearerMatches(authorization, opts.opsToken)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const permit = sessionGrantGate.enter('web');
      if (!permit.ok) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(permit.retryAfterSeconds),
        });
        res.end(JSON.stringify({ error: 'too many activation lease requests' }));
        return;
      }
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await readBody(req, SESSION_GRANT_BODY_BYTES, 5_000)) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body');
        body = parsed as Record<string, unknown>;
      } catch {
        if (!res.destroyed) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid request' }));
        }
        permit.release();
        return;
      }
      const account = typeof body.account === 'string' ? body.account.toLowerCase() : '';
      const agent = typeof body.agent === 'string' ? body.agent : '';
      const publicKey = typeof body.publicKey === 'string' ? body.publicKey.toLowerCase() : '';
      const leaseToken = typeof body.leaseToken === 'string' ? body.leaseToken.toLowerCase() : '';
      const managerSet = managers.get(agent);
      const managerToken = managerSet ? managerTokenFor(managerSet, publicKey) : undefined;
      if (
        !ADDRESS_RE.test(account)
        || !PUBLIC_KEY_RE.test(publicKey)
        || !LEASE_TOKEN_RE.test(leaseToken)
        || !managerSet
        || !managerToken
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid request' }));
        permit.release();
        return;
      }
      const key = `${account}:${agent}:${managerToken}`;
      const now = Date.now();
      for (const [knownKey, knownLease] of grantLeases) {
        if (knownLease.expiresAt <= now) grantLeases.delete(knownKey);
      }
      const lease = grantLeases.get(key);

      if (req.method === 'DELETE') {
        if (grantLeases.get(key)?.token === leaseToken) grantLeases.delete(key);
        res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
        res.end(JSON.stringify({ released: true }));
        permit.release();
        return;
      }

      const expiry = body.expiry;
      const nowSeconds = Math.floor(now / 1_000);
      if (
        typeof expiry !== 'number'
        || !Number.isSafeInteger(expiry)
        || expiry <= nowSeconds
        || expiry > nowSeconds + MAX_SESSION_SECONDS + SESSION_EXPIRY_CLOCK_SKEW_SECONDS
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid session expiry' }));
        permit.release();
        return;
      }

      // A completed handoff survives process restarts in the managed registry.
      // Permit another asset's distinct manager, but never rotate this asset's
      // manager while its previous on-chain authorization may still be live.
      let persistedConflict = false;
      try {
        persistedConflict = await livePersistedManagerConflict({
          agent,
          account,
          publicKey,
          managerToken,
          managerSet,
          nowSeconds,
        });
        if (!persistedConflict && managerSet.retired?.length) {
          persistedConflict = await retiredManagerConflict({
            account: account as Hex,
            managerToken,
            retired: managerSet.retired,
            nowSeconds,
          });
        }
      } catch {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'activation lease state unavailable' }));
        permit.release();
        return;
      }
      if (persistedConflict) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'a previous manager binding may still be live' }));
        permit.release();
        return;
      }
      const activeLease = grantLeases.get(key);
      if (activeLease && activeLease.token !== leaseToken) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'another activation is submitting' }));
        permit.release();
        return;
      }
      if (!activeLease && grantLeases.size >= 1_024) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'activation lease capacity unavailable' }));
        permit.release();
        return;
      }
      grantLeases.set(key, { token: leaseToken, expiresAt: now + SESSION_GRANT_LEASE_MS });
      res.writeHead(201, { 'cache-control': 'no-store', 'content-type': 'application/json' });
      res.end(JSON.stringify({ acquired: true }));
      permit.release();
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: [...opts.agents.keys()] }));
      return;
    }
    if (pathname === '/funding/quote') {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (!fundingMerchant) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'funding routes are not configured on this runner' }));
        return;
      }
      const asset = parseFundingAsset(new URL(req.url ?? '/', 'http://localhost').searchParams.get('asset'));
      if (!asset) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'asset must be BTCB, BNB, USDT, or USDC' }));
        return;
      }
      const permit = fundingQuoteGate.enter(FUNDING_QUOTE_GLOBAL_KEY);
      if (!permit.ok) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(permit.retryAfterSeconds),
        });
        res.end(JSON.stringify({ error: 'too many funding quote requests' }));
        return;
      }
      // A disconnected client does not cancel the shared quorum work. Hold the
      // slot until that work actually settles so disconnect/retry cannot bypass
      // the process-wide concurrency ceiling.
      try {
        const quote = await getFundingQuote(asset);
        if (!res.destroyed) {
          res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
          res.end(JSON.stringify(quote));
        }
      } catch {
        if (!res.destroyed) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'funding quote unavailable' }));
        }
      } finally {
        permit.release();
      }
      return;
    }
    if (pathname === '/funding/merchant') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (!fundingMerchant) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'funding routes are not configured on this runner' }));
        return;
      }
      // Read a strictly bounded body before taking a scarce merchant slot.
      // Slow or trickled uploads are disconnected after five seconds, so they
      // cannot exhaust the 16 relay-processing permits.
      let body: string;
      try {
        body = await readBody(req, FUNDING_MERCHANT_BODY_BYTES, 5_000);
      } catch {
        if (!res.destroyed) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body too large, timed out, or unreadable' }));
        }
        return;
      }
      const ingressPermit = fundingMerchantIngressGate.enter(FUNDING_MERCHANT_GLOBAL_KEY);
      if (!ingressPermit.ok) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(ingressPermit.retryAfterSeconds),
        });
        res.end(JSON.stringify({ error: 'too many funding preparations' }));
        return;
      }
      // The bounded in-memory Request below is independent of the incoming
      // socket. A disconnect cannot cancel it, so only release the slot in the
      // finally after merchant/relay processing actually stops.
      try {
        const account = fundingRequestAccount(body);
        if (!account) {
          if (!res.destroyed) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid funding preparation request' }));
          }
          return;
        }
        try {
          fundingFeePayerReady ??= prepareFundingFeePayer(opts.facilitatorKey).catch((error) => {
            fundingFeePayerReady = null;
            throw error;
          });
          await fundingFeePayerReady;
        } catch {
          if (!res.destroyed) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'funding fee payer unavailable' }));
          }
          return;
        }
        // Call Porto's Fetch handler only after consuming a bounded body. The
        // runner is reachable through the tunnel as well as the web proxy, so
        // its memory safety cannot rely on Next.js having screened the request.
        const response = await fundingMerchant.fetch(new Request('http://localhost/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }));
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'funding merchant unavailable' }));
        } else {
          res.destroy();
        }
      } finally {
        ingressPermit.release();
      }
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
      const retired = token
        ? (managerSet.retired ?? []).filter((grant) => grant.token === token)
        : [];
      res.end(JSON.stringify({
        agent,
        token: token ?? null,
        publicKey: identity.publicKey,
        address: identity.address,
        ...(retired.length ? { retired } : {}),
      }));
      return;
    }

    // Public liveness/registration facts used by the owner's dashboard. It
    // discloses no session bytes: only service state and Ranger's public NFT id.
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
      // Ranger's NFT remains the user's on-chain position after a session is
      // revoked or expires. The registry entry is then removed, but the
      // namespaced runner state is retained so the dashboard can still account
      // for that deployed principal instead of showing only idle balances.
      const canonicalTarget = managedStrategyFor(agent)?.callScopes[0]?.to;
      const positionTokenId = canonicalTarget?.toLowerCase() === targetAddress.toLowerCase()
        ? managedRangerTokenId(
            agent,
            runtime.ctx.state.get(
              managedAccountStateKey(account as Hex, 'position'),
              null,
            ),
          )
        : null;
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        registered,
        service: !registered ? 'not-registered' : halted.halted ? 'halted' : ready ? 'ready' : 'unavailable',
        reason: !registered
          ? null
          : halted.reason ?? (!fresh ? 'managed sweep heartbeat is stale or not yet available' : health?.reason ?? null),
        lastSweepAt: health?.at ?? null,
        positionTokenId,
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
