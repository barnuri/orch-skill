import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { orchPaths } from "../files/paths";
import type { RunState } from "../../shared/types/run-state";
import { annotateActivity } from "./node-activity";
import { readEvents } from "./run-events-reader";
import { nonOverlapping, reconcileOnce } from "./run-reconciler";

const home = mkdtempSync(join(tmpdir(), "orch-vis-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const paths = orchPaths(home);
mkdirSync(join(paths.runs, "r1", "out", "n"), { recursive: true });
mkdirSync(join(paths.jobs, "j1"), { recursive: true });

function run(node: Record<string, unknown>): RunState {
  return { run_id: "r1", title: "t", status: "running", started: "x", finished: null, harness_session: "s", nodes: [node], edges: [] } as unknown as RunState;
}
const old = "2020-01-01T00:00:00Z";

test("a running node with no recent activity is stale", () => {
  const r = run({ id: "n", status: "running", started: old, updated: old, job_id: null });
  annotateActivity(paths, r);
  expect(r.nodes[0]?.stale).toBe(true);
});

test("a fresh ping keeps a node live", () => {
  const r = run({ id: "n", status: "running", started: old, updated: new Date().toISOString(), job_id: null });
  annotateActivity(paths, r);
  expect(r.nodes[0]?.stale).toBe(false);
});

test("a recently written out file or job log counts as activity", () => {
  writeFileSync(join(paths.runs, "r1", "out", "n", "f.md"), "x");
  const r = run({ id: "n", status: "running", started: old, updated: old, job_id: null });
  annotateActivity(paths, r);
  expect(r.nodes[0]?.stale).toBe(false);
  utimesSync(join(paths.runs, "r1", "out", "n", "f.md"), new Date(old), new Date(old));
  writeFileSync(join(paths.jobs, "j1", "log"), "x");
  const r2 = run({ id: "n", status: "running", started: old, updated: old, job_id: "j1" });
  annotateActivity(paths, r2);
  expect(r2.nodes[0]?.stale).toBe(false);
});

test("stale_minutes from settings is honored", () => {
  writeFileSync(paths.profiles, JSON.stringify({ settings: { stale_minutes: 100000000 } }));
  const r = run({ id: "n", status: "running", started: old, updated: old, job_id: null });
  annotateActivity(paths, r);
  expect(r.nodes[0]?.stale).toBe(false);
  rmSync(paths.profiles);
});

test("events: cursor and cap", () => {
  const lines = Array.from({ length: 250 }, (_, i) => JSON.stringify({ at: old, kind: "status", node: "n", from: "a", to: "b", note: null, by: "cli", i }));
  writeFileSync(join(paths.runs, "r1", "events.jsonl"), `${lines.join("\n")}\n`);
  const all = readEvents(paths, "r1", 0);
  expect(all?.events.length).toBe(200);
  expect(all?.next).toBe(250);
  expect(all?.events.at(-1)?.n).toBe(250);
  expect(readEvents(paths, "r1", 248)?.events.map((e) => e.n)).toEqual([249, 250]);
  expect(readEvents(paths, "../x", 0)).toBeNull();
});

test("reconciler runs one run at a time and survives failures", async () => {
  const seen: string[] = [];
  let active = 0;
  let maxActive = 0;
  const logs: string[] = [];
  const n = await reconcileOnce(
    {
      runningRunIds: () => ["a", "b", "c"],
      spawn: async (id) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        seen.push(id);
        active -= 1;
        if (id === "b") {
          throw new Error("boom");
        }
        return { code: 0, stderr: "" };
      },
    },
    (l) => logs.push(l),
  );
  expect(n).toBe(3);
  expect(seen).toEqual(["a", "b", "c"]);
  expect(maxActive).toBe(1);
  expect(logs.length).toBe(1);
});

test("a pass never overlaps itself", async () => {
  let calls = 0;
  const tick = nonOverlapping(async () => {
    calls += 1;
    await Bun.sleep(20);
  });
  await Promise.all([tick(), tick(), tick()]);
  expect(calls).toBe(1);
});
