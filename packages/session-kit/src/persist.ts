/**
 * Session persistence. Sessions REQUIRE byte-exact persistence: the relay
 * validates against the exact granted object, and any re-serialization that
 * reorders keys or reformats values breaks the session. These helpers are
 * the only supported way to write a session to disk or read one back.
 *
 * bigint fields (spend limits) are encoded as "bigint:<decimal>" strings,
 * the same convention the spike session files on disk already use.
 */

import { deserializeSession, serializeSession } from './codec';

export { deserializeSession, roundTripIsExact, serializeSession } from './codec';

// File helpers stay in this Node-only module. Browser consumers import the
// separate `@agripinaa/session-kit/codec` entrypoint instead.

export async function saveSessionFile(path: string, session: unknown): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, serializeSession(session), 'utf8');
}

export async function loadSessionFile(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises');
  return deserializeSession(await readFile(path, 'utf8'));
}
