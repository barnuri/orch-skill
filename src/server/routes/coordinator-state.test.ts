import { afterAll, describe, expect, test } from "bun:test";

import type { RunEnvelope } from "../../shared/types/run-envelope";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const RUN_ID = "20261116-120000-coor";
const servers: TestServerHandle[] = [];
afterAll(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

describe("GET /api/runs/<id> coordinator state", () => {
  test("exposes reachability, unreachable since, pending asks, last repoint and candidates", async () => {
    const srv = startTestServer();
    servers.push(srv);
    const cand = { socket_path: "/s", pane_id: "p9", workspace_id: "w", cwd: "/r", session_id: "", agent: "opencode" };
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({
      run_id: RUN_ID, title: "t", harness_session: "", started: "2026-11-16T12:00:00Z", finished: null, status: "running", nodes: [], edges: [],
      coordinator: {
        pane_id: "p1", unreachable: { reason: "pane or socket gone", at: "2026-11-16T12:01:00Z" }, candidates: [cand],
        last_repoint: { at: "2026-11-16T11:00:00Z", from: "p0", to: "p1", reason: "same session" },
      },
    }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/m1.json`, JSON.stringify({ id: "m1", kind: "ask", delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/m2.json`, JSON.stringify({ id: "m2", kind: "ask", delivered_at: "x", status: "delivered" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    const c = body.run.coordinator_state;
    expect(c?.reachable).toBe(false);
    expect(c?.unreachable_since).toBe("2026-11-16T12:01:00Z");
    expect(c?.unreachable_reason).toBe("pane or socket gone");
    expect(c?.pending_asks).toBe(1);
    expect(c?.last_repoint?.reason).toBe("same session");
    expect(c?.candidates.map((x) => x.pane_id)).toEqual(["p9"]);
  });

  test("a run without a coordinator has no coordinator_state", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({ run_id: RUN_ID, title: "t", status: "running", nodes: [], edges: [] }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    expect(body.run.coordinator_state).toBeUndefined();
  });
});
