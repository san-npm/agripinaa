import { isAddress } from 'viem';

import { getExecutionSummary } from '@/lib/exec';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/exec/[owner]/orders'>,
): Promise<Response> {
  const { owner } = await ctx.params;
  if (!isAddress(owner)) {
    return Response.json({ error: 'invalid address' }, { status: 400 });
  }
  return Response.json(await getExecutionSummary(owner));
}
