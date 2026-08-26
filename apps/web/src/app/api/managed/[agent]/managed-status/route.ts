import { agentBySlug } from '@agripinaa/shared/agents';
import { isAddress } from 'viem';

import { proxyToRunner } from '@/lib/proxy-runner';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ agent: string }> },
): Promise<Response> {
  const { agent } = await ctx.params;
  if (!agentBySlug(agent)) return Response.json({ error: 'invalid agent' }, { status: 400 });
  const query = new URL(request.url).searchParams;
  const account = query.get('account') ?? '';
  const router = query.get('router') ?? '';
  if (!isAddress(account) || !isAddress(router)) {
    return Response.json({ error: 'invalid account or router' }, { status: 400 });
  }
  const suffix = `?account=${encodeURIComponent(account)}&router=${encodeURIComponent(router)}`;
  return proxyToRunner(`/${agent}/managed-status${suffix}`, {
    timeoutMs: 5_000,
    maxBytes: 8_192,
    maxRedirects: 0,
  });
}
