import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { RunOverview } from "../../shared/types/run-overview";
import { dispatchPath } from "../dispatch-path";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import type { ServerContext } from "../types/server-context";
import { readRunOverviewHandler } from "./overview-route";

function dispatch(home: string, args: string[]): string {
  const r = spawnSync(process.execPath, [dispatchPath(), ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_HEALTH_MONITOR: "0" },
    input: "",
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`dispatch ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim().split("\n").pop() ?? "";
}

describe("GET /api/runs/{id}/overview", () => {
  test("returns the overview JSON for a run with nodes and handoff evidence", async () => {
    const t: TestServerHandle = startTestServer();
    try {
      const id = dispatch(t.home.path, ["run", "start", "json overview"]);
      dispatch(t.home.path, ["node", "add", id, "a", "Node A"]);
      dispatch(t.home.path, ["node", "add", id, "b", "Node B"]);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(t.home.path, "runs", id, "out", "a"), { recursive: true });
      writeFileSync(join(t.home.path, "runs", id, "out", "a", "handoff.md"), "# done\n");

      const res = await t.api(`/api/runs/${id}/overview`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as RunOverview;
      expect(body.run_id).toBe(id);
      expect(body.title).toBe("json overview");
      expect(body.node_count).toBe(body.nodes.length);
      expect(body.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["a", "b"]));
      expect(body.handoffs.find((h) => h.id === "a")?.state).toBe("yes");
      expect(body.handoffs.find((h) => h.id === "b")?.state).toBe("missing");
      expect(Array.isArray(body.pull_requests)).toBe(true);
      expect(Array.isArray(body.models)).toBe(true);
      expect(Array.isArray(body.skills)).toBe(true);
    } finally {
      t.stop();
    }
  }, 30_000);

  test("404 for an unknown run and 401 without a token", async () => {
    const t = startTestServer();
    try {
      const id = dispatch(t.home.path, ["run", "start", "auth"]);
      expect((await t.api("/api/runs/20260101-000000-zzzz/overview")).status).toBe(404);
      expect((await t.api(`/api/runs/${id}/overview`, {}, false)).status).toBe(401);
    } finally {
      t.stop();
    }
  }, 60_000);

  test("502 when dispatch does not return an overview for the run", async () => {
    const t = startTestServer();
    try {
      const id = dispatch(t.home.path, ["run", "start", "failing dispatch"]);
      const ctx = { paths: { home: t.home.path, runs: join(t.home.path, "runs") } } as unknown as ServerContext;
      const handler = readRunOverviewHandler(ctx, async () => ({ code: 1, stdout: "" }));
      const res = await handler(new Request("http://x"), { id });
      expect(res.status).toBe(502);
      const garbage = readRunOverviewHandler(ctx, async () => ({ code: 0, stdout: "not json" }));
      expect((await garbage(new Request("http://x"), { id })).status).toBe(502);
    } finally {
      t.stop();
    }
  }, 60_000);
});
