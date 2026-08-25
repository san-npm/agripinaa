import 'server-only';

/**
 * A counter in front of the chain reads an unauthenticated request can spend.
 *
 * POST /api/claim reads `ownerOf` (and, for a body whose signature recovers to
 * someone else, `getCode`) before it knows anything about the caller, and the
 * claim page reads the same pair per visit. The per-owner claim limit cannot
 * protect those: it is counted after the signature check, which is after the
 * reads. So a loop of well-formed junk would spend the shared BNB Chain RPC
 * budget every page on the site depends on. This is the guard that runs first.
 *
 * Two buckets per window, both checked, both counted:
 *
 * - the caller's, keyed on the first `x-forwarded-for` hop. Cheap and fair, but
 *   the value is a header, so it is only as good as the proxy in front of us.
 * - a global one. That is the bucket a flood from many forged addresses lands
 *   in, and the one that actually caps what the site can spend in a minute.
 *
 * Fixed windows, stored as a single value per bucket carrying the window it
 * counts for, so an expired window resets on read: the KV client here has no
 * TTL and no atomic increment (see kv.ts), and a stamped value needs neither.
 * Two requests landing together can read the same count and write back the same
 * number, which loses a tick. That costs precision at the limit and nothing
 * else; the point is the order of magnitude, not the exact count.
 *
 * Every failure direction is open on purpose: no KV configured, a read that
 * throws, a value that is not a counter, all let the request through. Without
 * the store this file is a no-op and claims work exactly as they did before it.
 */

/** The KV commands this needs. `ClaimKv` satisfies it, so callers share one store. */
export interface ThrottleKv {
  available(): boolean;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string): Promise<boolean>;
}

/** Window length. Short, so a throttled visitor is never stuck for long. */
export const CHAIN_READ_WINDOW_MS = 60 * 1_000;

/**
 * Per-window ceilings. A person claiming an agent makes a handful of requests,
 * and the whole site's judged traffic is far under the global number, so both
 * are set where only a loop notices them.
 */
export const CHAIN_READ_LIMIT_PER_CLIENT = 20;
export const CHAIN_READ_LIMIT_GLOBAL = 300;

const PREFIX = 'agripinaa:chain-reads:';

/** The bucket every request counts against, whatever address it came from. */
export const CHAIN_READ_GLOBAL_KEY = `${PREFIX}all`;

/** The bucket for a caller whose address we could not read. */
export const UNATTRIBUTED_CLIENT = 'unattributed';

/** The KV key holding one client's counter. */
export function chainReadKey(client: string): string {
  return `${PREFIX}client:${client}`;
}

/**
 * A caller's address as a bucket name: the first `x-forwarded-for` hop (the
 * client, with each proxy appended after it), bounded in length and restricted
 * to the characters an IPv4 or IPv6 address is written with. Anything else,
 * including an absent header on a local run, shares one bucket rather than
 * minting a key from whatever a caller sent.
 */
export function clientKey(headers: { get(name: string): string | null }): string {
  const first = (headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';
  // 45 characters is the longest an IPv6 address can be written as.
  if (first === '' || first.length > 45) return UNATTRIBUTED_CLIENT;
  const candidate = first.toLowerCase();
  return /^[0-9a-f.:]+$/.test(candidate) ? candidate : UNATTRIBUTED_CLIENT;
}

/** The count a stored bucket holds for `window`, and zero for anything else. */
function countFor(raw: string | null, window: number): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { w?: unknown; n?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.w !== window) return 0;
    const n = parsed.n;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function bucketValue(window: number, count: number): string {
  return JSON.stringify({ w: window, n: count });
}

/**
 * Take one slot for a chain read. True means the caller may make it; false
 * means a window's budget is spent and the caller is refused before anything
 * reaches an RPC node. A refusal costs the read that found it and no write.
 */
export async function takeChainRead(input: {
  /** Bucket name for the caller, from `clientKey`. */
  client: string;
  kv: ThrottleKv;
  /** Clock, injectable so a test can step across a window boundary. */
  now?: () => number;
}): Promise<boolean> {
  const { kv } = input;
  if (!kv.available()) return true;

  const window = Math.floor((input.now?.() ?? Date.now()) / CHAIN_READ_WINDOW_MS);
  const key = chainReadKey(input.client);

  let stored: (string | null)[];
  try {
    stored = await kv.mget([key, CHAIN_READ_GLOBAL_KEY]);
  } catch {
    return true;
  }

  const mine = countFor(stored[0] ?? null, window);
  const all = countFor(stored[1] ?? null, window);
  if (mine >= CHAIN_READ_LIMIT_PER_CLIENT || all >= CHAIN_READ_LIMIT_GLOBAL) return false;

  await Promise.all([
    kv.set(key, bucketValue(window, mine + 1)),
    kv.set(CHAIN_READ_GLOBAL_KEY, bucketValue(window, all + 1)),
  ]).catch(() => null);
  return true;
}
