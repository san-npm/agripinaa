import {
  CLAIM_CHAIN_ID,
  claimIsStale,
  decideClaim,
  getClaim,
  liveClaimChain,
} from '@/lib/claims';

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
  return Response.json({ stored: true, claim: decision.record });
}

/**
 * The stored claim for one agent. A claim only speaks for the owner who signed
 * it, so the current owner is read back here and a claim left behind by a
 * transfer is reported as gone rather than served as current.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const chainId = Number(url.searchParams.get('chainId') ?? '');
  const tokenId = url.searchParams.get('tokenId') ?? '';

  if (chainId !== CLAIM_CHAIN_ID) {
    return Response.json({ error: 'claims are supported on bnb chain only' }, { status: 400 });
  }
  if (!/^\d{1,78}$/.test(tokenId)) {
    return Response.json({ error: 'bad agent id' }, { status: 400 });
  }

  const record = await getClaim(chainId, tokenId);
  if (!record) {
    return Response.json({ error: 'no claim for this agent' }, { status: 404 });
  }

  const owner = await liveClaimChain.ownerOf(tokenId);
  if (claimIsStale(record, owner)) {
    return Response.json(
      { error: 'this identity has changed hands since it was claimed' },
      { status: 404 },
    );
  }

  return Response.json(
    { claim: record, owner },
    { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=60' } },
  );
}
