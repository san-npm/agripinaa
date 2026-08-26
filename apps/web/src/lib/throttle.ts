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
 * counts for. One Redis script checks both ceilings and increments both values
 * atomically before the caller may spend an RPC read, so a parallel flood
 * cannot make many reservations collapse into one last-write-wins counter.
 *
 * With no KV configured, or when the atomic reservation fails, the guarded
 * path closes: allowing an RPC read without a reservation would recreate the
 * unlimited-spend condition this guard exists to prevent. Pages can still use
 * their indexed fallback without spending the shared RPC budget.
 */

/** The KV commands this needs. `ClaimKv` satisfies it, so callers share one store. */
export interface ThrottleKv {
  available(): boolean;
  reserveCounterPair(input: {
    clientKey: string;
    globalKey: string;
    window: number;
    perClientLimit: number;
    globalLimit: number;
    ttlMs: number;
  }): Promise<boolean | null>;
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

/**
 * Take one slot for a chain read. True means the caller may make it, false
 * means a window's budget was authoritatively spent, and null means no safe
 * decision could be obtained from KV. The reservation happens before true is
 * returned, and both refusal states fail closed before an RPC call.
 */
export async function takeChainRead(input: {
  /** Bucket name for the caller, from `clientKey`. */
  client: string;
  kv: ThrottleKv;
  /** Clock, injectable so a test can step across a window boundary. */
  now?: () => number;
}): Promise<boolean | null> {
  const { kv } = input;
  if (!kv.available()) return null;

  const window = Math.floor((input.now?.() ?? Date.now()) / CHAIN_READ_WINDOW_MS);
  const key = chainReadKey(input.client);

  try {
    const reserved = await kv.reserveCounterPair({
      clientKey: key,
      globalKey: CHAIN_READ_GLOBAL_KEY,
      window,
      perClientLimit: CHAIN_READ_LIMIT_PER_CLIENT,
      globalLimit: CHAIN_READ_LIMIT_GLOBAL,
      // Two windows of slack: a key is never evicted while its stamped window
      // could still be the one an adjacent request is evaluating.
      ttlMs: CHAIN_READ_WINDOW_MS * 2,
    });
    return reserved;
  } catch {
    return null;
  }
}
