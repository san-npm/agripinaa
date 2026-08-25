import { decideClaim, decideClaimLookup, liveClaimChain } from '@/lib/claims';
import { recordLiveness } from '@/lib/liveness';

/**
 * An agent's on-chain owner proves control with an EIP-712 signature and
 * attaches the description, category, website, and endpoint the registry does
 * not carry. Every check before the write lives in `decideClaim`, which is
 * where the parsing, ownership, replay window, and rate limit are tested; this
 * handler only unwraps the request and shapes the response.
 *
 * Nothing here logs the body or the signature: the body is the owner's own
 * text and the signature is a credential over it.
 */
export async function POST(request: Request): Promise<Response> {
  const decision = await decideClaim({
    readBodyText: () => request.text(),
    chain: liveClaimChain,
  });

  if (!decision.ok) {
    return Response.json({ stored: false, error: decision.message }, { status: decision.status });
  }

  // The one probe that happens outside the cron, so an owner who just attached
  // an endpoint sees the answer on their listing instead of waiting for the next
  // re-probe. It runs only after the claim is stored (an ownership signature has
  // been checked by now, so nobody can aim it), and it never throws: a claim is
  // saved whatever the endpoint says. `probeEndpoint` answers within 5s on the
  // wall clock, dns and its one redirect hop included, so an endpoint that
  // accepts the connection and then stalls delays this response by that and no
  // more; the claim is already in KV either way.
  const { chainId, tokenId, endpoint } = decision.record.fields;
  if (endpoint) {
    await recordLiveness(chainId, tokenId, endpoint).catch(() => null);
  }

  return Response.json({ stored: true, claim: decision.record });
}

/**
 * The stored claim for one agent, read from KV and nowhere else. What the query
 * means and what to answer is `decideClaimLookup`; this handler only unwraps
 * the query string.
 *
 * `owner` is optional. Pass the current on-chain owner (an agent page has read
 * it already) and a claim left behind by a transfer is reported as gone instead
 * of served; the answer always carries `claim.signer`, so a caller can make the
 * same comparison itself.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const lookup = await decideClaimLookup({
    chainId: params.get('chainId'),
    tokenId: params.get('tokenId'),
    owner: params.get('owner'),
  });

  if (!lookup.ok) {
    return Response.json({ error: lookup.message }, { status: lookup.status });
  }
  return Response.json(
    { claim: lookup.record },
    { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=60' } },
  );
}
