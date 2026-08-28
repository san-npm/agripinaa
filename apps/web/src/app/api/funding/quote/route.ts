import { isFundingAsset } from '@agripinaa/shared/funding';

import { proxyToRunner } from '@/lib/proxy-runner';

const MAX_RESPONSE_BYTES = 16 * 1024;

export async function GET(request: Request): Promise<Response> {
  const asset = new URL(request.url).searchParams.get('asset');
  if (!isFundingAsset(asset)) {
    return Response.json({ error: 'asset must be BTCB, BNB, USDT, or USDC' }, { status: 400 });
  }
  return proxyToRunner(`/funding/quote?asset=${encodeURIComponent(asset)}`, {
    method: 'GET',
    timeoutMs: 15_000,
    maxBytes: MAX_RESPONSE_BYTES,
  });
}
