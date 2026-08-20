/**
 * Browser-safe session serialization. Keep this module free of Node imports so
 * client bundles can persist granted sessions without pulling in file-system
 * helpers from persist.ts.
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
