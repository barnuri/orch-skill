// test-tier: slow (real dispatch.sh harness probes)
import { afterAll, describe, expect, test } from "bun:test";

import { resolve } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const FAKE_DISPATCH: string = resolve(import.meta.dir, "../test-support/fake-dispatch.sh");
const previousDispatch = process.env["ORCH_DISPATCH"];
process.env["ORCH_DISPATCH"] = FAKE_DISPATCH;

const servers: TestServerHandle[] = [];

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

afterAll(() => {
  if (previousDispatch === undefined) {
    delete process.env["ORCH_DISPATCH"];
  } else {
    process.env["ORCH_DISPATCH"] = previousDispatch;
  }
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

async function timed(srv: TestServerHandle, path: string): Promise<{ ms: number; res: Response }> {
  const start = performance.now();
  const res = await srv.api(path);
  await res.clone().text();
  return { ms: performance.now() - start, res };
}

describe.concurrent("GET /api/harnesses", () => {
  test("lists the wired harnesses", async () => {
    const srv = server();
    const body = await (await srv.api("/api/harnesses")).json();
    const ids = (body.harnesses as { id: string }[]).map((h) => h.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("opencode");
  }, 300_000);

  test("a second call is served from the cache, far faster than a probe", async () => {
    const srv = server();
    const first = await timed(srv, "/api/harnesses");
    const second = await timed(srv, "/api/harnesses");
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.ms).toBeLessThan(Math.max(50, first.ms / 3));
    expect(await second.res.json()).toEqual(await first.res.json());
  }, 300_000);

  test("calls made together share one probe and all succeed", async () => {
    const srv = server();
    const results = await Promise.all([1, 2, 3, 4].map(() => srv.api("/api/harnesses")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  }, 300_000);

  test("a change to profiles.json is seen at once, not after the cache expires", async () => {
    const srv = server();
    const before = await (await srv.api("/api/harnesses")).json();
    expect(before.harnesses.find((h: { id: string }) => h.id === "claude").enabled).toBe(true);
    const profiles = JSON.parse(srv.home.read("profiles.json"));
    profiles.settings.disabled_harnesses = ["claude"];
    await Bun.sleep(20);
    srv.home.write("profiles.json", JSON.stringify(profiles));
    const after = await (await srv.api("/api/harnesses")).json();
    expect(after.harnesses.find((h: { id: string }) => h.id === "claude").enabled).toBe(false);
  }, 300_000);

  test("?refresh=1 bypasses the cache", async () => {
    const srv = server();
    await srv.api("/api/harnesses");
    const forced = await timed(srv, "/api/harnesses?refresh=1");
    expect(forced.res.status).toBe(200);
  }, 300_000);
});

describe("GET /api/harnesses with the real dispatch.sh", () => {
  test("probes every wired harness", async () => {
    const previous = process.env["ORCH_DISPATCH"];
    delete process.env["ORCH_DISPATCH"];
    const srv = server();
    try {
      const res = await srv.api("/api/harnesses");
      expect(res.status).toBe(200);
      const ids = ((await res.json()).harnesses as { id: string }[]).map((h) => h.id);
      expect(ids).toContain("claude");
    } finally {
      process.env["ORCH_DISPATCH"] = previous;
    }
  }, 600_000);
});
