import { kvAvailable, kvSet } from '@/lib/kv';
import { decideRunnerUrlReport } from '@/lib/ops-runner-url';
import { RUNNER_URL_KEY } from '@/lib/runner-url';

/**
 * The VM posts its freshly assigned tunnel URL here on every tunnel start (see
 * ops/report-runner-url.sh), so a rotated quick tunnel is picked up without a
 * redeploy. Every decision before the write lives in decideRunnerUrlReport,
 * which is where the auth, parsing, and SSRF checks are tested.
 *
 * Storage needs KV. Without it the report is accepted and then dropped, which
 * would read as success, so an unconfigured KV answers 503 with a reason
 * instead of 200. `AGENTS_BASE_URL` remains the override that needs no KV.
 */
export async function POST(request: Request): Promise<Response> {
  const decision = await decideRunnerUrlReport({
    opsToken: process.env.OPS_TOKEN,
    authorization: request.headers.get('authorization'),
    readBodyText: () => request.text(),
  });

  if (!decision.ok) {
    return Response.json({ stored: false, error: decision.message }, { status: decision.status });
  }
  if (!kvAvailable()) {
    return Response.json(
      { stored: false, url: decision.url, error: 'kv not configured' },
      { status: 503 },
    );
  }

  const stored = await kvSet(RUNNER_URL_KEY, decision.url);
  return Response.json(
    stored
      ? { stored, url: decision.url }
      : { stored, url: decision.url, error: 'kv write failed' },
    { status: stored ? 200 : 503 },
  );
}
