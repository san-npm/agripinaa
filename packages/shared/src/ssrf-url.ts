/**
 * The synchronous, dependency-free half of the SSRF guard: what a URL is
 * allowed to look like before anyone tries to fetch it. Scheme, host literal,
 * and the private-range tables live here; DNS resolution, redirects, and the
 * capped fetch stay in `ssrf.ts`.
 *
 * Split out because this half runs in the browser too. The claim form
 * sanitises an owner's website and endpoint with `assertSafeUrl` and has to
 * reach the same verdict the server does, and `ssrf.ts` pulls
 * `node:dns/promises`, which a client bundle cannot resolve. `ssrf.ts`
 * re-exports both public names, so every existing importer is unaffected.
 */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export class BlockedUrlError extends Error {}

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null if it is not
 * one. Textual prefix matching is not enough here: the WHATWG URL parser
 * rewrites an embedded IPv4 tail into hex, so `[::ffff:127.0.0.1]` reaches us
 * as `[::ffff:7f00:1]` and a `::ffff:` strip leaves `7f00:1`, which looks like
 * neither a dotted quad nor anything the old prefix tests recognised.
 */
function ipv6Groups(input: string): number[] | null {
  let s = input;
  const v4Tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4Tail) {
    const o = [v4Tail[2], v4Tail[3], v4Tail[4], v4Tail[5]].map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((o[0]! << 8) | o[1]!).toString(16);
    const lo = ((o[2]! << 8) | o[3]!).toString(16);
    s = `${v4Tail[1]}${hi}:${lo}`;
  }
  if (!/^[0-9a-f:]+$/i.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part.length === 0
      ? []
      : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function isPrivateIpv6(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1

  // Any form that carries an IPv4 address in its low 32 bits: v4-mapped
  // (::ffff:0:0/96), v4-compatible (::/96), and NAT64 (64:ff9b::/96).
  const lowIsV4 =
    (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) ||
    (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0);
  if (lowIsV4) return isPrivateIpv4((g[6]! >> 8) & 0xff, g[6]! & 0xff);

  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local, not just fe80:
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  return false;
}

/**
 * Whether a host literal names something unreachable from the public internet.
 * Exported for `assertResolvedHostPublic`, which runs the same test against
 * each address a DNS name resolves to.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;

  const v6 = ipv6Groups(h.replace(/^\[|\]$/g, ''));
  if (v6) return isPrivateIpv6(v6);

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false; // a DNS name; resolved and re-checked in assertResolvedHostPublic
  return isPrivateIpv4(Number(m[1]), Number(m[2]));
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
