import { proxyToRunner } from '@/lib/proxy-runner';
import { readLimitedRequestText } from '@/lib/request-body';

export async function POST(request: Request): Promise<Response> {
  const token = process.env.OPS_TOKEN?.trim();
  if (!token) return Response.json({ error: 'Funding sender is not configured' }, { status: 503 });
  let body: string;
  try { body = await readLimitedRequestText(request, 256 * 1024); }
  catch { return Response.json({ error: 'Invalid funding request body' }, { status: 413 }); }
  return proxyToRunner('/internal/funding-relay', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body, timeoutMs: 60_000, maxBytes: 256 * 1024,
  });
}
