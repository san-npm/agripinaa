import { createServer, type Server } from 'node:http';

import { TOKENS_BSC, toBaseUnits } from '@agripinaa/shared';
import { createX402Merchant } from '@altananetwork/x402-server';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import type { AgentContext, AgentModule } from './types';

/** 0.05 USDT per status call. */
const PRICE = toBaseUnits('0.05', TOKENS_BSC.USDT!.decimals);

/**
 * One HTTP server for all agents: GET /:agent/status behind an x402
 * permit2-exact paywall (USDT on BSC). The facilitator key broadcasts
 * settlements and pays gas; payTo is each agent's own wallet.
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

  const server = createServer(async (req, res) => {
    const match = /^\/([a-z-]+)\/status$/.exec(req.url ?? '');
    const entry = match ? opts.agents.get(match[1]!) : undefined;
    const merchant = match ? merchants.get(match[1]!) : undefined;

    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agents: [...opts.agents.keys()] }));
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
      const status = await entry.module.status(entry.ctx);
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
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: err instanceof Error ? err.message : 'internal' }),
      );
    }
  });

  server.listen(opts.port);
  return server;
}
