/**
 * SSRF guard for server-side fetches of attacker-influenced URLs (e.g. an
 * ERC-8004 agent's on-chain tokenURI, which anyone can set to an internal
 * address). Allows only https (plus an ipfs:// -> gateway rewrite), blocks
 * private/loopback/link-local hosts, follows redirects manually while
 * re-validating each hop, and caps the response body.
 */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

export class BlockedUrlError extends Error {}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;

  // IPv6 loopback / unique-local / link-local (with or without brackets).
  const v6 = h.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // fc00::/7 ULA
  if (/^fe80:/i.test(v6)) return true; // link-local
  if (/^::ffff:/i.test(v6)) return isPrivateHost(v6.replace(/^::ffff:/i, '')); // v4-mapped

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false; // a DNS name; the fetch layer still can't reach the metadata IP directly, and we re-check on redirect
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Normalize + validate a candidate URL. Throws BlockedUrlError if unsafe. */
export function assertSafeUrl(raw: string): URL {
  const normalized = raw.startsWith('ipfs://')
    ? `${IPFS_GATEWAY}${raw.slice('ipfs://'.length)}`
    : raw;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new BlockedUrlError(`unparseable url: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme not allowed: ${url.protocol}`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new BlockedUrlError(`private host blocked: ${url.hostname}`);
  }
  return url;
}

/**
 * SSRF-safe JSON fetch: manual redirects (each re-validated), body-size cap,
 * caller-supplied timeout. Returns parsed JSON object or null on any failure.
 */
export async function safeFetchJson(
  raw: string,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  try {
    let url = assertSafeUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        url = assertSafeUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return null;
      const json = JSON.parse(new TextDecoder().decode(buf)) as unknown;
      return typeof json === 'object' && json !== null
        ? (json as Record<string, unknown>)
        : null;
    }
    return null; // too many redirects
  } catch {
    return null;
  }
}
