import { listClaims } from '@/lib/claims';
import { decideCronAccess, runRefresh } from '@/lib/cron-refresh';
import { listDirectory } from '@/lib/data';
import { recordLiveness } from '@/lib/liveness';

/**
 * The daily refresh (see apps/web/vercel.json for the schedule).
 *
 * Vercel's scheduler calls this with `Authorization: Bearer $CRON_SECRET`;
 * `OPS_TOKEN` works too, so the same run can be triggered by hand. Every
 * decision and every count lives in lib/cron-refresh.ts, which is where they
 * are tested; this handler reads the environment and the header, hands in the
 * live dependencies, and answers with the counts. The only thing it logs is
 * those counts: the bearer and the claim bodies both pass through here.
 */

/**
 * The platform caps how long this may run. The refresh budgets itself to 50 s
 * inside that, so it answers with counts rather than being cut off mid-probe.
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const access = decideCronAccess({
    opsToken: process.env.OPS_TOKEN,
    cronSecret: process.env.CRON_SECRET,
    authorization: request.headers.get('authorization'),
  });
  if (!access.ok) {
    return Response.json({ refreshed: false, error: access.message }, { status: access.status });
  }

  const counts = await runRefresh({
    listClaims,
    probe: async ({ chainId, tokenId, url }) =>
      (await recordLiveness(chainId, tokenId, url)).live,
    // The same call the hub page makes, so this fills the entry it reads
    // rather than a neighbouring one.
    warmHub: async (category) => {
      await listDirectory(category);
    },
    now: Date.now,
  });

  // The counts and nothing else: numbers, plus the fixed phrases the run builds
  // for what it did not finish. The bearer and the claim bodies never appear.
  // Without this a starved run is invisible, since the platform log keeps the
  // status code and not the body.
  console.log('cron refresh', JSON.stringify(counts));

  return Response.json({ refreshed: true, ...counts });
}
