// test-tier: slow (stand-in dispatch.ts processes)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HealthSummary, RunHealthEnvelope } from "../../shared/types/run-health";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const RUN = "20261115-100000-abcd";
const servers: TestServerHandle[] = [];
let previous: string | undefined;

// A stand-in for dispatch.ts: `run health <id> --json` prints the contract's JSON for that id.
const FAKE = `
const a = process.argv.slice(2);
if (a[0] === "run" && a[1] === "health" && a[3] === "--json") {
  console.log(JSON.stringify({ run: a[2], at: "2026-11-15T10:00:00Z", max_parallel: 2, running: 1, slots: 1, nodes: [{ id: "a", status: "running", health: "dead", owner_id: null, last_activity: null, idle_min: null, note: "owner gone" }], ready: ["b"], changes: [] }));
  process.exit(0);
}
if (a[0] === "herdr" && a[1] === "health" && a[2] === "--json") {
  console.log(JSON.stringify({ state: "degraded", enabled: true, reason: "on (ORCH_HERDR=1)", env_id: "orch-skill", pid: 42, pid_alive: true, socket_ok: true, registry: "missing", registry_path: "/x/orch-skill.json", web: "missing", web_url: "http://127.0.0.1:2222", nudged: false, at: "2026-11-15T10:00:00Z", problems: ["herdr web registry file is missing"] }));
  process.exit(1);
}
console.error("fake: unsupported " + a.join(" "));
process.exit(2);
`;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "orch-health-fake-"));
  const path = join(dir, "dispatch.ts");
  writeFileSync(path, FAKE);
  chmodSync(path, 0o755);
  previous = process.env["ORCH_DISPATCH"];
  process.env["ORCH_DISPATCH"] = path;
});

afterAll(() => {
  for (const s of servers) {
    s.stop();
  }
  if (previous === undefined) {
    delete process.env["ORCH_DISPATCH"];
  } else {
    process.env["ORCH_DISPATCH"] = previous;
  }
});

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  srv.home.write(
    `runs/${RUN}/state.json`,
    JSON.stringify({ run_id: RUN, title: "t", harness_session: "", started: "2026-11-15T10:00:00Z", finished: null, status: "running", nodes: [], edges: [] }),
  );
  return srv;
}

describe.concurrent("GET /api/runs/{id}/health", () => {
  test("200 with the latest check", async () => {
    const srv = server();
    const res = await srv.api(`/api/runs/${RUN}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunHealthEnvelope;
    expect(body.source).toBe("watcher");
    expect(body.health?.run).toBe(RUN);
    expect(body.health?.nodes[0]?.health).toBe("dead");
    expect(body.health?.ready).toEqual(["b"]);
  });

  test("404 for an unknown run", async () => {
    const srv = server();
    const res = await srv.api("/api/runs/20200101-000000-0000/health");
    expect(res.status).toBe(404);
  });

  test("401 without the token", async () => {
    const srv = server();
    const res = await srv.api(`/api/runs/${RUN}/health`, {}, false);
    expect(res.status).toBe(401);
  });

  test("GET /api/health/summary answers from memory: zeros before a check, counts after", async () => {
    const srv = server();
    const before = (await (await srv.api("/api/health/summary")).json()) as HealthSummary;
    expect(before).toMatchObject({ running_runs: 1, dead: 0, flagged_runs: [] });
    await srv.api(`/api/runs/${RUN}/health`);
    const after = (await (await srv.api("/api/health/summary")).json()) as HealthSummary;
    expect(after).toMatchObject({ running_runs: 1, dead: 1, ready: 1, flagged_runs: [RUN] });
    expect((await srv.api("/api/health/summary", {}, false)).status).toBe(401);
  });

  test("GET /api/health/summary carries the orch herdr instance's check", async () => {
    const srv = server();
    const body = (await (await srv.api("/api/health/summary")).json()) as HealthSummary;
    expect(body.herdr).toMatchObject({ state: "degraded", env_id: "orch-skill", socket_ok: true, registry: "missing", web: "missing" });
    expect(body.herdr?.problems).toEqual(["herdr web registry file is missing"]);
  });

  test("is in the OpenAPI document", async () => {
    const srv = server();
    const doc = (await (await srv.api("/api/openapi.json")).json()) as { paths: Record<string, { get?: unknown }> };
    expect(doc.paths["/api/runs/{id}/health"]?.get).toBeDefined();
    expect(doc.paths["/api/health/summary"]?.get).toBeDefined();
  });
});
