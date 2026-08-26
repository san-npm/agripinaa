/**
 * SSRF guard for server-side fetches of attacker-influenced URLs (e.g. an
 * ERC-8004 agent's on-chain tokenURI, which anyone can set to an internal
 * address). Allows only https (plus an ipfs:// -> gateway rewrite), blocks
 * private/loopback/link-local hosts, follows redirects manually while
 * re-validating each hop, and caps the response body while it streams.
 *
 * The URL rules themselves are in `ssrf-url.ts`, which is free of Node
 * built-ins so a browser bundle can run them; this module keeps the DNS,
 * redirect, and fetch half and re-exports both public names, so importing
 * `assertSafeUrl` or `BlockedUrlError` from here still works.
 */
import { assertSafeUrl, BlockedUrlError, isPrivateHost } from './ssrf-url';

export { assertSafeUrl, BlockedUrlError };

const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/** The body crossed the caller's cap; the stream was cancelled at that point. */
export class OversizedBodyError extends Error {}

/** A DNS resolver, injectable for tests. Mirrors node:dns lookup(all:true). */
export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

let defaultLookup: LookupFn | null = null;
async function nodeLookup(hostname: string): Promise<{ address: string }[]> {
  if (!defaultLookup) {
    const dns = await import('node:dns/promises');
    defaultLookup = (h) => dns.lookup(h, { all: true });
  }
  return defaultLookup(hostname);
}

/**
 * Resolve a DNS hostname and require EVERY resolved address to be public.
 * IP literals are already validated by assertSafeUrl, so this only runs for
 * names. Closes the DNS-to-private and (per-hop) DNS-rebinding bypass where a
 * public-looking hostname resolves to 169.254.169.254 / 127.0.0.1 / RFC1918.
 */
export async function assertResolvedHostPublic(
  url: URL,
  lookup: LookupFn = nodeLookup,
): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return; // IP literal, already checked
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new BlockedUrlError(`dns resolution failed: ${hostname}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`no addresses: ${hostname}`);
  for (const { address } of addresses) {
    if (isPrivateHost(address)) {
      throw new BlockedUrlError(`hostname ${hostname} resolves to private ${address}`);
    }
  }
}

/**
 * The slice of a response body stream `readBodyCapped` reads, described
 * structurally instead of by the `ReadableStream` global. That global is
 * lib.dom's under apps/web and @types/node's in the Node workspaces, and the
 * two are not assignable to each other (their `pipeThrough` and
 * async-iterator surfaces differ), so naming either one fails to compile on
 * the other side. It also resolves nowhere in session-kit, agent-index and
 * spikes, which typecheck these sources through the workspace link:
 * tsconfig.base.json sets `lib` to ES2022 with no DOM, deliberately, so a Node
 * package never sees `document` or `window`. A reader is all this function
 * needs, and every platform's stream hands one out.
 */
export type ResponseBodyStream = {
  getReader(): {
    read(): Promise<
      { done: false; value: Uint8Array } | { done: true; value?: Uint8Array | undefined }
    >;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
};

/**
 * Read a body up to `maxBytes`, cancelling the stream (and with it the
 * connection) the moment the cap is crossed. Checking the length after
 * `arrayBuffer()` would buffer the whole body first, which lets one oversized
 * upstream response exhaust the process before it is rejected; this bounds the
 * memory cost to the cap plus one chunk.
 */
export async function readBodyCapped(
  body: ResponseBodyStream | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new OversizedBodyError(`body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  /** Body cap in bytes, enforced while streaming. Defaults to 256 KB. */
  maxBytes?: number;
  /**
   * Redirect hops to follow, each re-validated. Defaults to 3 for a GET and is
   * always 0 for anything else: following a redirected POST would either
   * replay the body to a host the caller never named or silently turn it into
   * a GET, and neither is what a proxy should do.
   */
  maxRedirects?: number;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /**
   * The transport, injectable for tests, the way `assertResolvedHostPublic`
   * takes a `LookupFn`. A caller that has to stand in for the network gets a
   * per-call option instead of swapping `globalThis.fetch`, which is
   * process-wide and reaches every other module in the run.
   *
   * It is NOT a way around the guard: the url is validated before this is
   * called, and every redirect hop is revalidated before the next call, so a
   * stub sees only destinations the guard already accepted. Defaults to the
   * global fetch, read at call time so an existing global swap still works.
   */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * SSRF-safe fetch at the byte level: the initial URL and every redirect hop
 * are validated (scheme, host literal, resolved addresses), and the body is
 * capped as it streams. Returns whatever final status the upstream answered,
 * so a proxy can pass a runner's own 4xx and message through. Throws
 * BlockedUrlError when a URL or redirect is refused, OversizedBodyError when
 * the body crosses the cap, and lets network and timeout errors propagate.
 */
export async function safeFetchBytes(raw: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const method = opts.method ?? 'GET';
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const maxRedirects = method === 'GET' ? (opts.maxRedirects ?? MAX_REDIRECTS) : 0;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let url = assertSafeUrl(raw);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-resolve+validate every hop so a hostname cannot rebind to a
    // private address between the literal check and the connection.
    await assertResolvedHostPublic(url);
    const res = await doFetch(url, {
      method,
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location) throw new BlockedUrlError('redirect without a location');
      // Validate the target even on the last permitted hop, so the error names
      // a private destination when there is one.
      url = assertSafeUrl(new URL(location, url).toString());
      continue;
    }
    const bytes = await readBodyCapped(res.body, maxBytes);
    return { status: res.status, ok: res.ok, bytes };
  }
  throw new BlockedUrlError(maxRedirects === 0 ? 'redirect refused' : 'too many redirects');
}

/**
 * SSRF-safe JSON fetch: manual redirects (each re-validated), streamed
 * body-size cap, caller-supplied timeout. Returns the parsed JSON object or
 * null on any failure, including a non-2xx status.
 */
export async function safeFetchJson(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Record<string, unknown> | null> {
  try {
    const res = await safeFetchBytes(raw, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = JSON.parse(new TextDecoder().decode(res.bytes)) as unknown;
    return typeof json === 'object' && json !== null
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
