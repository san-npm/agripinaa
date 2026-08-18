import { getReceipt } from '@/lib/exec';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/exec/receipt/[uid]'>,
): Promise<Response> {
  const { uid } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{112}$/.test(uid)) {
    return Response.json({ error: 'invalid order uid' }, { status: 400 });
  }
  const payload = await getReceipt(uid);
  if (!payload) return Response.json({ error: 'order not found' }, { status: 404 });
  return Response.json(payload);
}
