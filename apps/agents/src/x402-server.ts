import { createServer, type Server } from 'node:http';

import { TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';
import { createX402Merchant } from '@altananetwork/x402-server';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { collectProofEvents } from './proof';
import type { AgentContext, AgentModule } from './types';

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
  rpcUrl?: string;
}): Server {
  const facilitator = privateKeyToAccount(opts.facilitatorKey);

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
    const value = collectProofEvents([...opts.agents.keys()], 40);
    proofCache = { expiresAt: now + 15_000, value };
    return value;
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
