import { afterAll, describe, expect, test } from "bun:test";

import type { RunMessagesEnvelope } from "../../shared/types/run-message";
import type { RunState } from "../../shared/types/run-state";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

// Real dispatch.ts: `node tell` and `node answer` write the inbox under the test server's TempHome.
const RUN_ID: string = "20261115-120000-msgs";
const servers: TestServerHandle[] = [];

afterAll(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  const state: RunState = {
    run_id: RUN_ID,
    title: "messages",
    harness_session: "sess-1",
    started: "2026-11-15T12:00:00Z",
    finished: null,
    status: "running",
    nodes: [
      {
        id: "a",
        label: "a",
        status: "running",
        profile: null,
        adapter: "claude",
        job_id: null,
        started: "2026-11-15T12:00:00Z",
        finished: null,
        error: null,
        log_tail: [],
      },
    ],
    edges: [],
  };
  srv.home.write(`runs/${RUN_ID}/state.json`, JSON.stringify(state));
  return srv;
}

function post(srv: TestServerHandle, path: string, body: unknown): Promise<Response> {
  return srv.api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function messages(srv: TestServerHandle): Promise<RunMessagesEnvelope["messages"]> {
  const res = await srv.api(`/api/runs/${RUN_ID}/messages`);
  expect(res.status).toBe(200);
  return ((await res.json()) as RunMessagesEnvelope).messages;
}

function seedAsk(srv: TestServerHandle): void {
  srv.home.write(`runs/${RUN_ID}/inbox/.seq`, "1\n");
  srv.home.write(
    `runs/${RUN_ID}/inbox/orch/1.json`,
    JSON.stringify({
      id: "m1", seq: 1, from: "a", to: "orch", kind: "ask", at: "2026-11-15T12:01:00Z", text: "which db?",
      delivered_at: null, via: null, tries: 0, status: "pending", last_error: null,
      answer: null, answered_at: null, waiting: false,
    }),
  );
}

describe.concurrent("node message routes (real dispatch.ts)", () => {
  test("tell stores a pending message from the user in the node's inbox", async () => {
    const srv = server();
    const res = await post(srv, `/api/runs/${RUN_ID}/nodes/a/tell`, { text: "  use sqlite  " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { output: string }).output).toBe("m1 a pending");
    const list = await messages(srv);
    expect(list.map((m) => [m.id, m.from, m.to, m.kind, m.text, m.status])).toEqual([
      ["m1", "user", "a", "tell", "use sqlite", "pending"],
    ]);
  }, 60_000);

  test("answer closes the open ask and sends the node an answer", async () => {
    const srv = server();
    seedAsk(srv);
    expect((await messages(srv)).map((m) => m.answer)).toEqual([null]);
    const res = await post(srv, `/api/runs/${RUN_ID}/nodes/a/answer`, { text: "postgres", ask: "m1" });
    expect(res.status).toBe(200);
    const list = await messages(srv);
    const ask = list.find((m) => m.id === "m1");
    expect(ask?.answer).toBe("postgres");
    const reply = list.find((m) => m.kind === "answer");
    expect(reply?.reply_to).toBe("m1");
    expect(reply?.to).toBe("a");
    const again = await post(srv, `/api/runs/${RUN_ID}/nodes/a/answer`, { text: "x", ask: "m1" });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain("already answered");
  }, 60_000);

  test("answer without an open ask is 400", async () => {
    const srv = server();
    const res = await post(srv, `/api/runs/${RUN_ID}/nodes/a/answer`, { text: "nothing asked" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no open ask");
  }, 60_000);

  test("empty text, a bad ask id, an unknown node and no token are refused", async () => {
    const srv = server();
    expect((await post(srv, `/api/runs/${RUN_ID}/nodes/a/tell`, { text: "   " })).status).toBe(400);
    expect((await post(srv, `/api/runs/${RUN_ID}/nodes/a/answer`, { text: "x", ask: "../1" })).status).toBe(400);
    expect((await post(srv, `/api/runs/${RUN_ID}/nodes/zz/tell`, { text: "hi" })).status).toBe(400);
    const anon = await srv.api(`/api/runs/${RUN_ID}/nodes/a/tell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    }, false);
    expect(anon.status).toBe(401);
  }, 60_000);

  test("messages of a run without an inbox, or a malformed id, are empty", async () => {
    const srv = server();
    expect(await messages(srv)).toEqual([]);
    const res = await srv.api("/api/runs/..%2Fx/messages");
    expect([200, 404]).toContain(res.status);
  }, 60_000);
});
