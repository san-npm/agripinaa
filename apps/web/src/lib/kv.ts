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
