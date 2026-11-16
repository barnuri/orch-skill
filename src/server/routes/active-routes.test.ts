// test-tier: slow (real dispatch.ts loop stop)
import { afterEach, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const servers: TestServerHandle[] = [];

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

// A loop that already failed needs no live process to be reported, so the test needs no daemon.
function writeFailedLoop(srv: TestServerHandle, id: string): void {
  srv.home.write(
    `loops/${id}/spec.json`,
    JSON.stringify({ id, kind: "profile", name: "claude-default", interval: 600, max: 5, started: "2026-11-12T10:00:00Z", deadline: 4102444800, session_mode: "fresh", session: "" }),
  );
  srv.home.write(
    `loops/${id}/state.json`,
    JSON.stringify({ id, status: "failed", iteration: 3, failures: 5, next_tick: 1, last_exit: 1, reason: "failures", pid: null }),
  );
}

describe("GET /api/active", () => {
  test("an empty state dir lists nothing", async () => {
    const srv = server();
    const res = await srv.api("/api/active");
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });

  test("a failed loop is listed with its fields, because it needs attention", async () => {
    const srv = server();
    writeFailedLoop(srv, "loop-test-1");
    const body = await (await srv.api("/api/active")).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: "loop", id: "loop-test-1", name: "claude-default", status: "failed", iteration: 3, max: 5, interval: 600 });
  });

  test("an unchanged list answers 304", async () => {
    const srv = server();
    writeFailedLoop(srv, "loop-test-2");
    const etag = (await srv.api("/api/active")).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    expect((await srv.api("/api/active", { headers: { "If-None-Match": etag } })).status).toBe(304);
  });
});

describe("POST /api/active/:id/stop", () => {
  test("an id that is not a loop or watch id is refused before it reaches the shell", async () => {
    const srv = server();
    for (const bad of ["x", "loop-1", "loop-20261112-101010-zzzz", "job-20261112-101010-abcd"]) {
      const res = await srv.api(`/api/active/${bad}/stop`, { method: "POST" });
      expect(res.status).toBe(400);
    }
  });

  test("a well-formed id that does not exist is 404", async () => {
    const srv = server();
    const res = await srv.api("/api/active/loop-20261112-101010-abcd/stop", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("a failed loop is stopped and then reads as stopped", async () => {
    const srv = server();
    writeFailedLoop(srv, "loop-20261112-101010-abcd");
    const res = await srv.api("/api/active/loop-20261112-101010-abcd/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(JSON.parse(srv.home.read("loops/loop-20261112-101010-abcd/state.json")).status).toBe("stopped");
  });
});
