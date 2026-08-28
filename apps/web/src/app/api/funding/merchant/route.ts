import { proxyToRunner } from '@/lib/proxy-runner';
import { readLimitedRequestText, RequestBodyTooLargeError } from '@/lib/request-body';

/** Prepared relay contexts include typed data and asset diffs, but remain bounded JSON. */
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
  let body: string;
  try {
    body = await readLimitedRequestText(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'body too large' }, { status: 413 });
    }
    return Response.json({ error: 'body must be valid UTF-8' }, { status: 400 });
  }
  return proxyToRunner('/funding/merchant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    timeoutMs: 60_000,
    maxBytes: MAX_BODY_BYTES,
  });
}
