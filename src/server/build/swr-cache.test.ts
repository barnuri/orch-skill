import { describe, expect, test } from "bun:test";

import { SwrCache } from "./swr-cache";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SwrCache", () => {
  test("get never waits: fallback before the first load, then the cached value", async () => {
    const d = deferred<number>();
    let loads = 0;
    const c = new SwrCache<number>(() => {
      loads++;
      return d.promise;
    }, 30_000);
    expect(c.get(() => -1)).toBe(-1);
    expect(c.get(() => -1)).toBe(-1);
    expect(loads).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(loads).toBe(1);
    expect(c.get(() => -1)).toBe(-1);
    await new Promise((r) => setImmediate(r));
    expect(loads).toBe(1);
    d.resolve(7);
    await c.fresh();
    expect(c.get(() => -1)).toBe(7);
    expect(loads).toBe(1);
  });

  test("after the TTL get answers the stale value and starts one background load", async () => {
    let now = 0;
    let n = 0;
    let gate = deferred<void>();
    const c = new SwrCache<number>(
      async () => {
        await gate.promise;
        return ++n;
      },
      1000,
      () => "",
      () => now,
    );
    gate.resolve();
    expect(await c.fresh()).toBe(1);
    now = 999;
    expect(c.get(() => 0)).toBe(1);
    now = 1000;
    gate = deferred<void>();
    expect(c.get(() => 0)).toBe(1);
    expect(c.get(() => 0)).toBe(1);
    gate.resolve();
    await c.fresh();
    expect(c.get(() => 0)).toBe(2);
    expect(n).toBe(2);
  });

  test("invalidate and a key change revalidate", async () => {
    let key = "a";
    let n = 0;
    const c = new SwrCache<number>(async () => ++n, 60_000, () => key);
    expect(await c.fresh()).toBe(1);
    expect(await c.fresh()).toBe(1);
    c.invalidate();
    expect(await c.fresh()).toBe(2);
    key = "b";
    expect(await c.fresh()).toBe(3);
    expect(await c.fresh()).toBe(3);
  });

  test("a failed load keeps the previous value; the first failure rejects fresh but not get", async () => {
    let fail = true;
    const c = new SwrCache<number>(async () => {
      if (fail) throw new Error("boom");
      return 5;
    }, 0);
    expect(c.get(() => -1)).toBe(-1);
    await expect(c.fresh()).rejects.toThrow("boom");
    fail = false;
    expect(await c.fresh()).toBe(5);
    fail = true;
    expect(await c.fresh()).toBe(5);
  });
});
