import { describe, expect, test } from "bun:test";

import { EVERY_MS, FIRST_MS, Periodic, type Timers } from "./periodic";

/** A fake clock: timers fire only when `advance` passes their due time. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 0;
  const jobs = new Map<number, { at: number; every: number | null; fn: () => void }>();
  return {
    setTimeout: (fn, ms) => {
      jobs.set(++next, { at: now + ms, every: null, fn });
      return next;
    },
    setInterval: (fn, ms) => {
      jobs.set(++next, { at: now + ms, every: ms, fn });
      return next;
    },
    clearTimeout: (h) => void jobs.delete(h as number),
    clearInterval: (h) => void jobs.delete(h as number),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, job] = due;
        now = job.at;
        if (job.every === null) jobs.delete(id);
        else job.at += job.every;
        job.fn();
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("Periodic", () => {
  test("first run 60 s after start, then every 15 minutes", async () => {
    const t = fakeTimers();
    let n = 0;
    const p = new Periodic<number>(async () => ++n, { timeoutMs: 1000, timers: t });
    p.start();
    expect(FIRST_MS).toBe(60_000);
    expect(EVERY_MS).toBe(900_000);
    t.advance(59_999);
    await flush();
    expect(n).toBe(0);
    expect(p.get()).toBeNull();
    t.advance(1);
    await flush();
    expect(n).toBe(1);
    expect(p.get()).toBe(1);
    t.advance(EVERY_MS - FIRST_MS - 1);
    await flush();
    expect(n).toBe(1);
    t.advance(1);
    await flush();
    expect(n).toBe(2);
    t.advance(EVERY_MS);
    await flush();
    expect(n).toBe(3);
    p.stop();
    t.advance(10 * EVERY_MS);
    await flush();
    expect(n).toBe(3);
  });

  test("a tick while a run is in flight is skipped", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = new Periodic<number>(async () => {
      n++;
      await gate;
      return n;
    }, { timeoutMs: 60_000 });
    const first = p.tick();
    expect(p.busy).toBe(true);
    expect(await p.tick()).toBe(false);
    expect(await p.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(n).toBe(1);
    expect(p.busy).toBe(false);
    expect(await p.tick()).toBe(true);
    expect(n).toBe(2);
  });

  test("timeout aborts the load, frees the slot and keeps the old value", async () => {
    let hang = false;
    let aborted = false;
    const p = new Periodic<string>((signal) => {
      if (!hang) return Promise.resolve("good");
      signal.addEventListener("abort", () => (aborted = true));
      return new Promise<string>(() => {});
    }, { timeoutMs: 50 });
    await p.tick();
    expect(p.get()).toBe("good");
    hang = true;
    const started = performance.now();
    expect(await p.tick()).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(p.busy).toBe(false);
    expect(p.get()).toBe("good");
  });

  test("an error keeps the old value; with no value, onFirstError fills it", async () => {
    let fail = true;
    const p = new Periodic<string>(async () => {
      if (fail) throw new Error("boom");
      return "ok";
    }, { timeoutMs: 1000, onFirstError: (e) => `err:${(e as Error).message}` });
    await p.tick();
    expect(p.get()).toBe("err:boom");
    fail = false;
    await p.tick();
    expect(p.get()).toBe("ok");
    fail = true;
    await p.tick();
    expect(p.get()).toBe("ok");
  });
});
