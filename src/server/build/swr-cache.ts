/**
 * Stale-while-revalidate holder for one value. `get` never waits for a load: it answers the last value (or the
 * caller's cheap fallback before the first load ends) and starts one background load when the value is older than
 * the TTL, was invalidated, or its key changed. Concurrent loads are shared.
 */
export class SwrCache<T> {
  private value: T | null = null;
  private at = 0;
  private loadedKey: string | null = null;
  private dirty = false;
  private pending: Promise<T> | null = null;
  private scheduled = false;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly key: () => string = () => "",
    private readonly now: () => number = Date.now,
  ) {}

  /** The last loaded value, or null; never starts a load. */
  peek(): T | null {
    return this.value;
  }

  /** Marks the value out of date; the next `get` revalidates. */
  invalidate(): void {
    this.dirty = true;
  }

  private isFresh(): boolean {
    return this.value !== null && !this.dirty && this.now() - this.at < this.ttlMs && this.key() === this.loadedKey;
  }

  /** Never waits: the cached value, or `fallback()` before the first load ends. Starts a background load when not fresh. */
  get(fallback: () => T): T {
    const value = this.value;
    if (!this.isFresh() && !this.scheduled && this.pending === null) {
      // The load starts on the next macrotask, so its synchronous part (process spawns) stays off the caller's path.
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        if (!this.isFresh()) {
          void this.refresh().catch(() => {});
        }
      });
    }
    return value ?? fallback();
  }

  /**
   * Waits only when the value is not fresh; concurrent callers share one load. A load already in flight may have
   * started before the caller's change, so it is awaited and the value is checked again.
   */
  async fresh(): Promise<T> {
    if (this.pending !== null) {
      await this.pending.catch(() => {});
    }
    return this.isFresh() ? (this.value as T) : this.refresh();
  }

  /** Starts a load unless one is in flight, and resolves with its value. A failed load keeps the previous value. */
  refresh(): Promise<T> {
    if (this.pending !== null) {
      return this.pending;
    }
    this.dirty = false;
    const key = this.key();
    const run = this.load().then(
      (v) => {
        this.value = v;
        this.at = this.now();
        this.loadedKey = key;
        return v;
      },
      (err: unknown) => {
        this.at = this.now();
        this.loadedKey = key;
        if (this.value === null) {
          throw err;
        }
        return this.value;
      },
    );
    const pending = run.finally(() => {
      if (this.pending === pending) {
        this.pending = null;
      }
    });
    this.pending = pending;
    return pending;
  }
}
