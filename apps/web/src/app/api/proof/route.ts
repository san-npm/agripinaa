import { getProofFeed } from '@/lib/proof';

export async function GET(): Promise<Response> {
  const payload = await getProofFeed();
  return Response.json(payload, {
    headers: {
      'cache-control': 'public, s-maxage=15, stale-while-revalidate=30',
    },
  });
}
