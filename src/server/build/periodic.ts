export const FIRST_MS: number = 60_000;
export const EVERY_MS: number = 15 * 60_000;

type Handle = unknown;

/** The timer calls Periodic uses, so a test can drive it with a fake clock. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): Handle;
  setInterval(fn: () => void, ms: number): Handle;
  clearTimeout(h: Handle): void;
  clearInterval(h: Handle): void;
}

const unref = (h: Handle): Handle => {
  (h as { unref?: () => void }).unref?.();
  return h;
};

export const realTimers: Timers = {
  setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
  setInterval: (fn, ms) => unref(setInterval(fn, ms)),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class Timeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
  }
}

export interface PeriodicOptions<T> {
  /** Hard cap for one load: the signal aborts (the load kills its children) and the run counts as failed. */
  timeoutMs: number;
  firstMs?: number;
  everyMs?: number;
  timers?: Timers;
  /** The value stored when a load fails and there is no earlier value. Default: none. */
  onFirstError?: (err: unknown) => T;
}

/**
 * One value refreshed in the background: first `firstMs` after `start`, then every `everyMs`. One load at a time (a
 * tick while a load runs is skipped). A failed or timed-out load keeps the old value. `get` only reads memory.
 */
export class Periodic<T> {
  private value: T | null = null;
  private running = false;
  private first: Handle | null = null;
  private every: Handle | null = null;
  private readonly timers: Timers;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<T>,
    private readonly opts: PeriodicOptions<T>,
  ) {
    this.timers = opts.timers ?? realTimers;
  }

  get(): T | null {
    return this.value;
  }

  get busy(): boolean {
    return this.running;
  }

  start(): void {
    if (this.first !== null || this.every !== null) {
      return;
    }
    this.first = this.timers.setTimeout(() => void this.tick(), this.opts.firstMs ?? FIRST_MS);
    this.every = this.timers.setInterval(() => void this.tick(), this.opts.everyMs ?? EVERY_MS);
  }

  stop(): void {
    if (this.first !== null) this.timers.clearTimeout(this.first);
    if (this.every !== null) this.timers.clearInterval(this.every);
    this.first = null;
    this.every = null;
  }

  /** Runs one load unless one is running. Resolves false when skipped; never rejects. */
  async tick(): Promise<boolean> {
    if (this.running) {
      return false;
    }
    this.running = true;
    const ac = new AbortController();
    let timer: Handle | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = this.timers.setTimeout(() => {
        const err = new Timeout(this.opts.timeoutMs);
        ac.abort(err);
        reject(err);
      }, this.opts.timeoutMs);
    });
    try {
      // A grandchild can keep a pipe open after the kill, so the wait races the deadline instead of trusting the load.
      this.value = await Promise.race([this.load(ac.signal), expired]);
    } catch (err) {
      if (this.value === null && this.opts.onFirstError !== undefined) {
        this.value = this.opts.onFirstError(err);
      }
    } finally {
      this.timers.clearTimeout(timer);
      this.running = false;
    }
    return true;
  }
}
