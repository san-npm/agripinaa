/** Read immediately, then refresh without overlapping slow requests. */
export function startPolling(read: () => Promise<unknown>, intervalMs = 15_000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  async function run() {
    try {
      await read();
    } catch {
      // Readers display their own unavailable state; a failed read must not stop refreshes.
    } finally {
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  }
  timer = setTimeout(run, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
