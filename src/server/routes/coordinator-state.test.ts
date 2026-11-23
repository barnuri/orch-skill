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
    srv.home.write(`runs/${RUN_ID}/inbox/orch/m2.json`, JSON.stringify({ id: "m2", kind: "ask", answer: "yes", answered_at: "x", delivered_at: "x", status: "delivered" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/m3.json`, JSON.stringify({ id: "m3", kind: "ask", answer: null, answered_late_expected: true, delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/m4.json`, JSON.stringify({ id: "m4", kind: "tell", from: "watchdog", delivered_at: null, status: "pending" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    const c = body.run.coordinator_state;
    expect(c?.reachable).toBe(false);
    expect(c?.unreachable_since).toBe("2026-11-16T12:01:00Z");
    expect(c?.unreachable_reason).toBe("pane or socket gone");
    expect(c?.pending_asks).toBe(1);
    expect(c?.last_repoint?.reason).toBe("same session");
    expect(c?.candidates.map((x) => x.pane_id)).toEqual(["p9"]);
  });

  test("routine tells and answered or late asks are not pending orchestrator questions", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({
      run_id: RUN_ID, title: "t", harness_session: "", started: "2026-11-16T12:00:00Z", finished: null, status: "running", nodes: [], edges: [],
      coordinator: { pane_id: "p1", candidates: [] },
    }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/t1.json`, JSON.stringify({ id: "t1", kind: "tell", from: "watchdog", delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/t2.json`, JSON.stringify({ id: "t2", kind: "tell", from: "n1", delivered_at: "x", status: "delivered" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/a1.json`, JSON.stringify({ id: "a1", kind: "ask", answer: "ok", answered_at: "x", delivered_at: "x", status: "delivered" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/a2.json`, JSON.stringify({ id: "a2", kind: "ask", answer: null, answered_late_expected: true, delivered_at: null, status: "pending" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    const c = body.run.coordinator_state;
    expect(c?.reachable).toBe(true);
    expect(c?.pending_asks).toBe(0);
  });

  test("an ask delivered but still unanswered stays pending; a node ask counts once", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({
      run_id: RUN_ID, title: "t", harness_session: "", started: "2026-11-16T12:00:00Z", finished: null, status: "running", nodes: [], edges: [],
      coordinator: { pane_id: "p1", candidates: [] },
    }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/q1.json`, JSON.stringify({ id: "q1", kind: "ask", from: "n1", answer: null, answered_at: null, delivered_at: "x", status: "delivered" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/q2.json`, JSON.stringify({ id: "q2", kind: "ask", from: "n2", answer: "", answered_at: null, delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/q3.json`, JSON.stringify({ id: "q3", kind: "ask", from: "n3", answer: "done", answered_at: "x", delivered_at: "x", status: "delivered" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    expect(body.run.coordinator_state?.pending_asks).toBe(2);
  });

  test("a watchdog tell never counts, even when the orchestrator is unreachable", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({
      run_id: RUN_ID, title: "t", harness_session: "", started: "2026-11-16T12:00:00Z", finished: null, status: "running", nodes: [], edges: [],
      coordinator: { pane_id: "p1", unreachable: { reason: "gone", at: "2026-11-16T12:01:00Z" }, candidates: [] },
    }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/w1.json`, JSON.stringify({ id: "w1", kind: "tell", from: "watchdog", text: "node n1 stalled", delivered_at: null, status: "pending" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    expect(body.run.coordinator_state?.reachable).toBe(false);
    expect(body.run.coordinator_state?.pending_asks).toBe(0);
  });

  test("a mix of node tells, watchdog tells, answered and late asks counts only the one open ask", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({
      run_id: RUN_ID, title: "t", harness_session: "", started: "2026-11-16T12:00:00Z", finished: null, status: "running", nodes: [], edges: [],
      coordinator: { pane_id: "p1", unreachable: { reason: "gone", at: "2026-11-16T12:01:00Z" }, candidates: [] },
    }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/n1.json`, JSON.stringify({ id: "n1", kind: "tell", from: "n1", text: "done", delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/w1.json`, JSON.stringify({ id: "w1", kind: "tell", from: "watchdog", text: "stalled", delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/a1.json`, JSON.stringify({ id: "a1", kind: "ask", from: "n4", answer: "yes", answered_at: "x", delivered_at: "x", status: "delivered" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/a2.json`, JSON.stringify({ id: "a2", kind: "ask", from: "n5", answer: null, answered_late_expected: true, delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/q1.json`, JSON.stringify({ id: "q1", kind: "ask", from: "n6", answer: null, answered_at: null, delivered_at: null, status: "pending" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    expect(body.run.coordinator_state?.reachable).toBe(false);
    expect(body.run.coordinator_state?.pending_asks).toBe(1);
  });

  test("a tell never counts, even when it carries ask-like fields; a message without kind is not an open question", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({
      run_id: RUN_ID, title: "t", harness_session: "", started: "2026-11-16T12:00:00Z", finished: null, status: "running", nodes: [], edges: [],
      coordinator: { pane_id: "p1", unreachable: { reason: "gone", at: "2026-11-16T12:01:00Z" }, candidates: [] },
    }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/k1.json`, JSON.stringify({ id: "k1", kind: "tell", from: "watchdog", answer: null, answered_at: null, delivered_at: null, status: "pending" }));
    srv.home.write(`runs/${RUN_ID}/inbox/orch/k2.json`, JSON.stringify({ id: "k2", from: "n1", answer: null, answered_at: null, delivered_at: null, status: "pending" }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    expect(body.run.coordinator_state?.reachable).toBe(false);
    expect(body.run.coordinator_state?.pending_asks).toBe(0);
  });

  test("a run without a coordinator has no coordinator_state", async () => {
    const srv = startTestServer();
    servers.push(srv);
    srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify({ run_id: RUN_ID, title: "t", status: "running", nodes: [], edges: [] }));
    const body = (await (await srv.api(`/api/runs/${RUN_ID}`)).json()) as RunEnvelope;
    expect(body.run.coordinator_state).toBeUndefined();
  });
});
