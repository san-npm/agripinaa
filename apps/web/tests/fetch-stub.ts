/**
 * Fetch stubs for the tests that exercise the runner boundary. Every stubbed
 * URL points at a public IP literal (AGENTS_BASE_URL is set to one), so the
 * shared SSRF guard skips its resolver and no test touches live DNS.
 */

export const RUNNER_BASE = 'https://203.0.113.10';

export interface FetchState {
  calls: { url: string; method: string }[];
  pulled: number;
  cancelled: boolean;
}

export function newState(): FetchState {
  return { calls: [], pulled: 0, cancelled: false };
}

/** A stream of `chunks` chunks of `chunkBytes` bytes, counting what is pulled. */
export function streamBody(state: FetchState, chunks: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      state.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

export function recordingFetch(
  state: FetchState,
  respond: (url: string, init: RequestInit | undefined) => Response,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    state.calls.push({ url, method: init?.method ?? 'GET' });
    return respond(url, init);
  };
}

export async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
