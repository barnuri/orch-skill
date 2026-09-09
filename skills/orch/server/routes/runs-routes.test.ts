import { afterEach, describe, expect, test } from "bun:test";

import type { NodeStatus } from "../../shared/types/node-status";
import type { RunState } from "../../shared/types/run-state";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const RUN_ID: string = "20260903-120000-abcd";
const ETAG_PATTERN = /^"[0-9a-f]{64}"$/;

const servers: TestServerHandle[] = [];

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

function node(id: string, status: NodeStatus): RunState["nodes"][number] {
  return {
    id,
    label: id,
    status,
    profile: "claude-sub",
    adapter: "claude",
    job_id: null,
    started: "2026-09-03T12:00:00Z",
    finished: status === "done" ? "2026-09-03T12:01:00Z" : null,
    error: null,
    log_tail: [],
  };
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: RUN_ID,
    title: "three node run",
    harness_session: "sess-1",
    started: "2026-09-03T12:00:00Z",
    finished: null,
    status: "running",
    nodes: [node("a", "done"), node("b", "running"), node("c", "waiting")],
    edges: [
      ["a", "b"],
      ["a", "c"],
    ],
    ...overrides,
  };
}

function seed(srv: TestServerHandle, id: string, state: RunState | string): void {
  srv.home.write(
    `runs/${id}/state.json`,
    typeof state === "string" ? state : JSON.stringify(state),
  );
}

afterEach(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

describe("GET /api/runs", () => {
  test("a fresh home lists nothing", async () => {
    const srv = server();
    const res = await srv.api("/api/runs");
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toEqual([]);
    expect(res.headers.get("etag")).toMatch(ETAG_PATTERN);
  });

  test("a seeded run is summarized with per-status counts", async () => {
    const srv = server();
    seed(srv, RUN_ID, runState());
    const body = await (await srv.api("/api/runs")).json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].run_id).toBe(RUN_ID);
    expect(body.runs[0].counts).toEqual({
      waiting: 1,
      running: 1,
      done: 1,
      error: 0,
      skipped: 0,
    });
  });

  test("runs come back newest first", async () => {
    const srv = server();
    seed(srv, "20260901-090000-old", runState({ run_id: "20260901-090000-old", started: "2026-09-01T09:00:00Z" }));
    seed(srv, "20260903-120000-new", runState({ run_id: "20260903-120000-new", started: "2026-09-03T12:00:00Z" }));
    const body = await (await srv.api("/api/runs")).json();
    expect(body.runs.map((r: { run_id: string }) => r.run_id)).toEqual([
      "20260903-120000-new",
      "20260901-090000-old",
    ]);
  });

  // The ETag covers the payload only, never `generated_at` — otherwise the 2 s poll would
  // download the whole list every tick.
  test("an unchanged runs tree answers 304", async () => {
    const srv = server();
    seed(srv, RUN_ID, runState());
    const etag = (await srv.api("/api/runs")).headers.get("etag") ?? "";
    const res = await srv.api("/api/runs", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
  });

  test("writing another run changes the ETag", async () => {
    const srv = server();
    seed(srv, RUN_ID, runState());
    const first = (await srv.api("/api/runs")).headers.get("etag");
    seed(srv, "20260903-130000-efgh", runState({ run_id: "20260903-130000-efgh" }));
    expect((await srv.api("/api/runs")).headers.get("etag")).not.toBe(first);
  });

  test("a corrupt state.json is skipped, not fatal", async () => {
    const srv = server();
    seed(srv, RUN_ID, runState());
    seed(srv, "20260903-140000-bad", "{ not json");
    const body = await (await srv.api("/api/runs")).json();
    expect(body.runs.map((r: { run_id: string }) => r.run_id)).toEqual([RUN_ID]);
  });
});

describe("GET /api/runs/:id", () => {
  test("it returns the full node and edge lists", async () => {
    const srv = server();
    seed(srv, RUN_ID, runState());
    const res = await srv.api(`/api/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.nodes).toHaveLength(3);
    expect(body.run.edges).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
  });

  test("an unchanged run answers 304", async () => {
    const srv = server();
    seed(srv, RUN_ID, runState());
    const etag = (await srv.api(`/api/runs/${RUN_ID}`)).headers.get("etag") ?? "";
    const res = await srv.api(`/api/runs/${RUN_ID}`, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
  });

  test("an unknown id is 404", async () => {
    const srv = server();
    expect((await srv.api("/api/runs/20260903-999999-zzzz")).status).toBe(404);
  });

  // The id alphabet forbids separators and leading dots, so no path can escape runs/.
  const rejected: readonly string[] = ["%2e%2e", "2026%2Fx", ".hidden"];
  for (const id of rejected) {
    test(`${id} is rejected as 404`, async () => {
      const srv = server();
      expect((await srv.api(`/api/runs/${id}`)).status).toBe(404);
    });
  }

  test("a corrupt state.json is a 500 that names the file, not its contents", async () => {
    const srv = server();
    seed(srv, RUN_ID, "{ not json");
    const res = await srv.api(`/api/runs/${RUN_ID}`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("state.json");
  });
});
