import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'Bearer ';

/**
 * Whether an Authorization header carries this token.
 *
 * Compare digests rather than the raw strings, so neither the token's bytes nor
 * its length can be recovered from response timing on an endpoint anyone can
 * reach. Shared by every ops-style route, so there is one implementation of the
 * comparison to get right.
 */
export function bearerMatches(header: string | null, token: string): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;
  const presented = createHash('sha256').update(header.slice(BEARER_PREFIX.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}
