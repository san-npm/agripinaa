/**
 * Session persistence. Sessions REQUIRE byte-exact persistence: the relay
 * validates against the exact granted object, and any re-serialization that
 * reorders keys or reformats values breaks the session. These helpers are
 * the only supported way to write a session to disk or read one back.
 *
 * bigint fields (spend limits) are encoded as "bigint:<decimal>" strings,
 * the same convention the spike session files on disk already use.
 */

const BIGINT_MARKER = 'bigint:';

export function serializeSession(session: unknown): string {
  return JSON.stringify(session, (_key, value: unknown) =>
    typeof value === 'bigint' ? BIGINT_MARKER + value.toString() : value,
  );
}

export function deserializeSession(raw: string): unknown {
  return JSON.parse(raw, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith(BIGINT_MARKER)
      ? BigInt(value.slice(BIGINT_MARKER.length))
      : value,
  );
}

/** True iff serialize(deserialize(serialize(x))) === serialize(x). */
export function roundTripIsExact(session: unknown): boolean {
  const first = serializeSession(session);
  return serializeSession(deserializeSession(first)) === first;
}

// File helpers use dynamic import so bundling this module for the browser
// never pulls node:fs at top level; only agents (Node) may call these.

export async function saveSessionFile(path: string, session: unknown): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, serializeSession(session), 'utf8');
}

export async function loadSessionFile(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises');
  return deserializeSession(await readFile(path, 'utf8'));
}
