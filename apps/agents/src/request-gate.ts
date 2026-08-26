export interface GatePermit {
  ok: true;
  release(): void;
}

export interface GateRefusal {
  ok: false;
  retryAfterSeconds: number;
}

/** Fixed-window per-client limiting plus a process-wide concurrency ceiling. */
export class RequestGate {
  private readonly windows = new Map<string, { resetAt: number; count: number }>();
  private active = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly maxConcurrent: number,
    private readonly maxKeys = 4_096,
  ) {}

  enter(key: string, now = Date.now()): GatePermit | GateRefusal {
    if (this.active >= this.maxConcurrent) return { ok: false, retryAfterSeconds: 1 };
    const current = this.windows.get(key);
    if (!current && this.windows.size >= this.maxKeys) {
      for (const [knownKey, value] of this.windows) {
        if (value.resetAt <= now) this.windows.delete(knownKey);
      }
      if (this.windows.size >= this.maxKeys) return { ok: false, retryAfterSeconds: 1 };
    }
    const window = !current || current.resetAt <= now
      ? { resetAt: now + this.windowMs, count: 0 }
      : current;
    if (window.count >= this.maxPerWindow) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      };
    }
    window.count += 1;
    this.windows.set(key, window);
    this.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }
}
