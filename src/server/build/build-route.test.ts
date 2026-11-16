// test-tier: slow (waits out the restart delay)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { RESTART_DELAY_MS } from "./restart";

let srv: TestServerHandle;
let dir: string;
let fake: string;
const saved = process.env["ORCH_SERVICE_SH"];

function installFake(installed: boolean): void {
  fake = join(dir, "service.sh");
  writeFileSync(
    fake,
    `#!/bin/bash\ncase "$1" in\n  status) ${installed ? "exit 0" : "exit 1"} ;;\n  restart) echo run >> "${dir}/calls" ;;\nesac\n`,
  );
  chmodSync(fake, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-restart-"));
  process.env["ORCH_SERVICE_SH"] = join(dir, "service.sh");
});

afterEach(() => {
  srv.stop();
  if (saved === undefined) {
    delete process.env["ORCH_SERVICE_SH"];
  } else {
    process.env["ORCH_SERVICE_SH"] = saved;
  }
  Bun.spawnSync(["trash", dir]);
});

// A restart that must NOT happen can only be proven by outlasting its delay; a restart that must
// happen is awaited by polling its marker file.
const PAST_DELAY_MS: number = RESTART_DELAY_MS + 300;

async function waitForCalls(count: number, timeoutMs: number = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (calls() < count && Date.now() < deadline) {
    await Bun.sleep(20);
  }
}

const calls = (): number => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean).length : 0);

describe("GET /api/build", () => {
  test("answers the build state without dispatch", async () => {
    installFake(true);
    srv = startTestServer();
    const res = await srv.api("/api/build");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["boot_at"]).toBe("string");
    expect(typeof body["stale"]).toBe("boolean");
    expect(body["busy"]).toEqual({ chats_streaming: 0, runs_running: 0 });
    expect(Array.isArray(body["missing_commits"])).toBe(true);
  });

  test("busy counts running run nodes", async () => {
    installFake(true);
    srv = startTestServer();
    const id = "run-20260101-000000-abcd";
    mkdirSync(join(srv.home.path, "runs", id), { recursive: true });
    const node = (n: string, status: string) => ({ id: n, label: n, status, profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [] });
    writeFileSync(
      join(srv.home.path, "runs", id, "state.json"),
      JSON.stringify({ run_id: id, title: "t", harness_session: "", started: "2026-01-01T00:00:00Z", finished: null, status: "running", nodes: [node("a", "running"), node("b", "running"), node("c", "done")], edges: [] }),
    );
    const body = (await (await srv.api("/api/build")).json()) as { busy: { runs_running: number } };
    expect(body.busy.runs_running).toBe(2);
  });

  test("needs auth", async () => {
    installFake(true);
    srv = startTestServer();
    expect((await srv.api("/api/build", {}, false)).status).toBe(401);
  });
});

describe("POST /api/build/restart", () => {
  test("not installed answers 409 with the manual command and runs nothing", async () => {
    installFake(false);
    srv = startTestServer();
    const res = await srv.api("/api/build/restart", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; command: string };
    expect(body.error).toBe("service not installed");
    expect(body.command).toContain("dispatch.sh ui");
    await Bun.sleep(PAST_DELAY_MS);
    expect(calls()).toBe(0);
  });

  test("installed: 202, the fake runs once after the delay, a second call within 60 s is 409", async () => {
    installFake(true);
    srv = startTestServer();
    const res = await srv.api("/api/build/restart", { method: "POST" });
    expect(res.status).toBe(202);
    expect(calls()).toBe(0);
    const again = await srv.api("/api/build/restart", { method: "POST" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("restart already requested");
    await waitForCalls(1);
    expect(calls()).toBe(1);
    expect(readFileSync(join(srv.home.path, "restart.log"), "utf8")).toContain("restart requested");
  });

  test("rejects without a token and other verbs are 405", async () => {
    installFake(true);
    srv = startTestServer();
    expect((await srv.api("/api/build/restart", { method: "POST" }, false)).status).toBe(401);
    expect((await srv.api("/api/build/restart")).status).toBe(405);
    await Bun.sleep(PAST_DELAY_MS);
    expect(calls()).toBe(0);
  });
});
