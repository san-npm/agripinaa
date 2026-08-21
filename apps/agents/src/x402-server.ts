import { createServer, type IncomingMessage, type Server } from 'node:http';

import { ROUTER_ACTIONS, TOKENS_BSC, routerByAddress, toBaseUnits } from '@agripinaa/shared';
import { deserializeSession } from '@agripinaa/session-kit/persist';
import { isSessionKeyValid } from '@agripinaa/session-kit/verify';
import { createX402Merchant } from '@altananetwork/x402-server';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { collectProofEvents } from './proof';
import { loadManaged, upsertManaged, type ManagedAccount } from './managed';
import type { AgentContext, AgentModule } from './types';

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
const ROUTER_SIGNATURES = new Set<string>(Object.values(ROUTER_ACTIONS).map((a) => a.signature));

/**
 * Reject any manage request that isn't a real, on-chain, router-scoped session
 * granted to our own manager key. Returns a human-readable problem, or null if
 * the request is safe to store. The security does not rest on this check (the
 * router is drain-proof regardless), but it keeps the registry to sessions we
 * can actually act on and that can only touch the router.
 */
async function validateManageRequest(
  body: { account?: string; chainId?: number; session?: ManagedAccount['session'] },
  managerSet: ManagerSet,
): Promise<string | null> {
  const { account, chainId, session } = body;
  if (typeof account !== 'string' || !ADDRESS_RE.test(account)) return 'account is not a 20-byte address';
  if (chainId !== 56 && chainId !== 97) return 'chainId must be 56 or 97';
  if (!session || typeof session !== 'object') return 'missing session';
  if (typeof session.walletAddress !== 'string' || session.walletAddress.toLowerCase() !== account.toLowerCase())
    return 'session.walletAddress must equal account';
  if (typeof session.publicKey !== 'string') return 'session is missing a public key';
  if (typeof session.expiry !== 'number' || session.expiry * 1000 <= Date.now())
    return 'session is missing or already expired';

  const calls = session.permissions?.calls ?? [];
  if (calls.length === 0) return 'session has no scoped calls (would be unrestricted)';
  // The session must be scoped to ONE known managed router (USDT or USDC) on
  // this chain, and to nothing but that router's selectors.
  const firstTo = 'to' in calls[0]! ? calls[0]!.to : undefined;
  const router = firstTo ? routerByAddress(firstTo) : undefined;
  if (!router || router.chainId !== chainId)
    return 'session is not scoped to a known managed router on this chain';
  for (const call of calls) {
    const to = 'to' in call ? call.to : undefined;
    const signature = 'signature' in call ? call.signature : undefined;
    if (!to || to.toLowerCase() !== router.address.toLowerCase())
      return 'session scopes a call to a non-router target';
    if (!signature || !ROUTER_SIGNATURES.has(signature))
      return 'session scopes a non-router selector';
  }

  // The session must be granted to the manager key for the token it manages —
  // never any other token's key. This binds the (token → key identity) mapping
  // so a USDC mandate can't be authorized against the USDT key or vice versa.
  const expected = managerSet.byToken.get(router.symbol);
  if (!expected || session.publicKey.toLowerCase() !== expected.publicKey.toLowerCase())
    return `session is not granted to this agent's ${router.symbol} manager key`;

  const live = await isSessionKeyValid({
    chainId,
    account: account as Hex,
    sessionPublicKey: session.publicKey as Hex,
  });
  if (!live) return 'session key is not registered/valid on-chain for this account';
  // NOTE (audit lead, defense-in-depth): the selector-scope check above reads
  // the CLIENT-supplied permissions, not the on-chain grant. That is safe here
  // because the account contract enforces the ACTUAL granted scope at execute
  // time — a registration lying about its permissions cannot widen what the
  // agent key can actually do on-chain. This check only keeps the registry to
  // sessions we can act on; the drain-proof guarantee rests on the router.
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
      try {
        const body = deserializeSession(await readBody(req)) as {
          account?: string;
          chainId?: number;
          session?: ManagedAccount['session'];
        };
        const problem = await validateManageRequest(body, managerSet);
        if (problem) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: problem }));
          return;
        }
        const entry: ManagedAccount = {
          account: body.account as Hex,
          chainId: body.chainId!,
          session: body.session!,
          registeredAt: new Date().toISOString(),
        };
        const all = upsertManaged(agent, entry);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: entry.account, managedCount: all.length }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }));
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
