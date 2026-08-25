import 'server-only';

/**
 * Minimal Upstash-REST key/value client. No dependency, and a no-op when the
 * env vars are absent so every caller keeps working without a KV provisioned.
 */
const URL_BASE = process.env.KV_REST_API_URL?.trim();
const TOKEN = process.env.KV_REST_API_TOKEN?.trim();

export function kvAvailable(): boolean {
  return Boolean(URL_BASE && TOKEN);
}

export async function kvGet(key: string): Promise<string | null> {
  if (!kvAvailable()) return null;
  try {
    const res = await fetch(`${URL_BASE}/get/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(3_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    return typeof body.result === 'string' ? body.result : null;
  } catch {
    return null;
  }
}

/**
 * Upstash caps a request line, so a long key list goes out in batches rather
 * than as one enormous URL. 100 keys per call keeps each request small while a
 * few thousand claims still cost only a handful of round trips.
 */
const MGET_BATCH = 100;

/**
 * Read many keys at once, always answering one entry per requested key and in
 * the same order (null for a missing key, and for a batch that failed). Sent as
 * a command array to the REST base rather than as a path, so key contents can
 * never overflow or escape the URL. A batch carries up to 100 values, so it
 * gets a little more time than the single-key reads above.
 */
export async function kvMGet(keys: string[]): Promise<(string | null)[]> {
  if (!kvAvailable() || keys.length === 0) return keys.map(() => null);
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += MGET_BATCH) {
    const batch = keys.slice(i, i + MGET_BATCH);
    let values: unknown[] = [];
    try {
      const res = await fetch(`${URL_BASE}/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(['MGET', ...batch]),
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: unknown };
        if (Array.isArray(body.result)) values = body.result;
      }
    } catch {
      values = [];
    }
    for (let j = 0; j < batch.length; j++) {
      out.push(typeof values[j] === 'string' ? (values[j] as string) : null);
    }
  }
  return out;
}

export async function kvSet(key: string, value: string): Promise<boolean> {
  if (!kvAvailable()) return false;
  try {
    const res = await fetch(`${URL_BASE}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
      body: value,
      signal: AbortSignal.timeout(3_000),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}
