import { afterEach, describe, expect, test } from "bun:test";

import type { NodeStatus } from "../../shared/types/node-status";
import type { RunState } from "../../shared/types/run-state";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatEnvelope } from "../../shared/types/chat-envelope";
import { orchPaths } from "../files/paths";
import { SessionChatReader } from "../runs/session-chat-reader";
import { TempHome } from "../test-support/temp-home";
import { startTestServer } from "../test-support/test-server";
import type { ServerContext } from "../types/server-context";
import { readJobChatHandler } from "./runs-routes";
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

// --- GET /api/jobs/:id/chat ---------------------------------------------------
// Driven through the handler rather than the test server: the route is wired with the default
// reader, which would read the developer's own ~/.claude.

const CHAT_JOB_ID: string = "20260915-120001-pid-1-1-1";
const CHAT_SESSION: string = "503edded-727a-4e03-86df-3b7ba63f7d8f";

const chatHomes: TempHome[] = [];
const claudeHomes: string[] = [];

function orchHomeWithSession(session: string | null): TempHome {
  const home = TempHome.create();
  chatHomes.push(home);
  if (session !== null) {
    home.write(`jobs/${CHAT_JOB_ID}/session`, `${session}\n`);
  } else {
    home.write(`jobs/${CHAT_JOB_ID}/log`, "output only\n");
  }
  return home;
}

function claudeHomeWithTurns(): string {
  const home = mkdtempSync(join(tmpdir(), "orch-claude-route-"));
  claudeHomes.push(home);
  const project = join(home, "projects", "-Users-someone-repo");
  mkdirSync(project, { recursive: true });
  const lines = [
    JSON.stringify({ uuid: "u1", type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({
      uuid: "a1",
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "went" }] },
    }),
  ];
  writeFileSync(join(project, `${CHAT_SESSION}.jsonl`), `${lines.join("\n")}\n`);
  return home;
}

function chatContext(home: TempHome): ServerContext {
  return {
    paths: orchPaths(home.path),
    bindHost: "127.0.0.1",
    hostname: "test",
    tokenDigest: new Uint8Array(),
    requireToken: false,
    requireRemoteToken: false,
    harnesses: ["claude"],
    outcomes: ["success"],
  };
}

function chatRequest(): Request {
  return new Request("http://test.invalid/api/jobs/x/chat");
}

afterEach(() => {
  chatHomes.splice(0);
  claudeHomes.splice(0);
});

describe("readJobChatHandler", () => {
  test("returns the session's turns for a job that recorded one", async () => {
    const handler = readJobChatHandler(
      chatContext(orchHomeWithSession(CHAT_SESSION)),
      new SessionChatReader(claudeHomeWithTurns()),
    );
    const res = await handler(chatRequest(), { id: CHAT_JOB_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatEnvelope;
    expect(body.job_id).toBe(CHAT_JOB_ID);
    expect(body.session).toBe(CHAT_SESSION);
    expect(body.turns.map((turn) => turn.text)).toEqual(["go", "went"]);
    expect(body.truncated).toBe(false);
    expect(res.headers.get("ETag")).toMatch(ETAG_PATTERN);
  });

  test("304s when the client already has the turns", async () => {
    const handler = readJobChatHandler(
      chatContext(orchHomeWithSession(CHAT_SESSION)),
      new SessionChatReader(claudeHomeWithTurns()),
    );
    const first = await handler(chatRequest(), { id: CHAT_JOB_ID });
    const etag = first.headers.get("ETag") ?? "";
    const req = new Request("http://test.invalid/api/jobs/x/chat", {
      headers: { "If-None-Match": etag },
    });
    expect((await handler(req, { id: CHAT_JOB_ID })).status).toBe(304);
  });

  test("404s for a job orch assigned no session — every adapter but claude", async () => {
    const handler = readJobChatHandler(
      chatContext(orchHomeWithSession(null)),
      new SessionChatReader(claudeHomeWithTurns()),
    );
    expect((await handler(chatRequest(), { id: CHAT_JOB_ID })).status).toBe(404);
  });

  test("404s when the session has no transcript on disk", async () => {
    const handler = readJobChatHandler(
      chatContext(orchHomeWithSession("11111111-2222-3333-4444-555555555555")),
      new SessionChatReader(claudeHomeWithTurns()),
    );
    expect((await handler(chatRequest(), { id: CHAT_JOB_ID })).status).toBe(404);
  });

  test("404s for an unknown job id", async () => {
    const handler = readJobChatHandler(
      chatContext(orchHomeWithSession(CHAT_SESSION)),
      new SessionChatReader(claudeHomeWithTurns()),
    );
    expect((await handler(chatRequest(), { id: "20260101-000000-pid-9-9-9" })).status).toBe(404);
  });
});
