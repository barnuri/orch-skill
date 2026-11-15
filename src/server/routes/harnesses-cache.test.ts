import { describe, expect, test } from "bun:test";

import type { HarnessesEnvelope } from "../../shared/types/harness-status";
import type { ServerContext } from "../types/server-context";
import { listHarnessesHandler } from "./harnesses-routes";

const envelope = (n: number): HarnessesEnvelope => ({ probed_at: String(n), harnesses: [] }) as unknown as HarnessesEnvelope;
const ctx = { paths: { profiles: "/nonexistent/profiles.json" } } as unknown as ServerContext;
const get = (h: ReturnType<typeof listHarnessesHandler>, q = "") => h(new Request(`http://x/api/harnesses${q}`), {});

describe("harnesses cache (stale-while-revalidate)", () => {
  test("an expired entry is served at once and refreshed in the background", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls > 1) await Bun.sleep(150);
      return envelope(calls);
    };
    const h = listHarnessesHandler(ctx, { probe, ttlMs: 20 });
    expect((await (await get(h)).json()).probed_at).toBe("1");
    await Bun.sleep(40);
    const start = performance.now();
    const stale = await (await get(h)).json();
    expect(performance.now() - start).toBeLessThan(100);
    expect(stale.probed_at).toBe("1");
    await Bun.sleep(250);
    expect((await (await get(h)).json()).probed_at).toBe("2");
  });

  test("callers during one background refresh start no second probe", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      await Bun.sleep(50);
      return envelope(calls);
    };
    const h = listHarnessesHandler(ctx, { probe, ttlMs: 10 });
    await get(h);
    await Bun.sleep(20);
    await Promise.all([get(h), get(h), get(h)]);
    await Bun.sleep(120);
    expect(calls).toBe(2);
  });

  test("a failed probe answers 500 and is not cached", async () => {
    let calls = 0;
    const probe = async () => (++calls === 1 ? { error: "boom" } : envelope(calls));
    const h = listHarnessesHandler(ctx, { probe });
    expect((await get(h)).status).toBe(500);
    expect((await get(h)).status).toBe(200);
  });
});
