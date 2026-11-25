import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoCleanup, tempDir } from "../helpers";
import { closureProblems } from "../../core/runs/closure.ts";
import { normReq, loadLedger } from "../../core/commands/req.ts";
import { auditRun } from "../../../../scripts/unorch-audit.ts";

autoCleanup();

test("closureProblems blocks waiting, ready and running nodes and needs no gate node", () => {
  expect(closureProblems({ nodes: [{ id: "a", status: "done" }] })).toEqual([]);
  expect(closureProblems({ nodes: [{ id: "a", status: "waiting" }] })).toEqual(["node a is waiting"]);
  expect(closureProblems({ nodes: [{ id: "a", status: "running" }] })).toEqual(["node a is running"]);
  expect(closureProblems({ nodes: [{ id: "a", status: "ready" }] })).toEqual(["node a is ready"]);
  expect(closureProblems({ nodes: [] })).toEqual([]);
});

test("legacy requirement statuses are read as their new names", () => {
  expect(normReq("handled")).toBe("implemented");
  expect(normReq("partly")).toBe("in_progress");
  expect(normReq("not")).toBe("open");
  expect(normReq("done")).toBe("done");
});

test("loadLedger maps legacy statuses on read and leaves the file unchanged", async () => {
  const home = tempDir("gate-legacy-");
  mkdirSync(join(home, "runs", "r-1"), { recursive: true });
  const file = join(home, "runs", "r-1", "requirements.json");
  const raw = JSON.stringify({ requirements: [{ id: "R1", text: "t", status: "handled", nodes: [], evidence: [] }] });
  writeFileSync(file, raw);
  const l = await loadLedger(home, "r-1");
  expect(l.requirements[0]!.status).toBe("implemented");
  expect(await Bun.file(file).text()).toBe(raw);
});

// The CLI cases (run finish, run carry) spawn dispatch.ts and live in tests/runs/closure-gate-cli.test.ts.

test("audit: a done run with an open node is a high finding", () => {
  const home = tempDir("gate-audit-");
  mkdirSync(join(home, "runs", "x-1"), { recursive: true });
  writeFileSync(join(home, "runs", "x-1", "state.json"), JSON.stringify({ status: "done", nodes: [{ id: "a", status: "waiting" }] }));
  const { findings } = auditRun(home, "x-1");
  const f = findings.find((x) => x.rule === "run-closed-with-open-nodes");
  expect(f?.severity).toBe("high");
  expect(f?.fact).toMatch(/node a is waiting/);
});

test("audit: a legacy requirement status is a medium finding and is judged by its new name", () => {
  const home = tempDir("gate-audit-legacy-");
  mkdirSync(join(home, "runs", "x-2"), { recursive: true });
  writeFileSync(join(home, "runs", "x-2", "state.json"), JSON.stringify({ status: "running", nodes: [] }));
  writeFileSync(join(home, "runs", "x-2", "requirements.json"), JSON.stringify({ requirements: [{ id: "R1", text: "ship the page", status: "handled", nodes: [], evidence: [] }] }));
  const { findings, reqs } = auditRun(home, "x-2");
  const f = findings.find((x) => x.rule === "legacy-requirement-status");
  expect(f?.severity).toBe("medium");
  expect(f?.fact).toMatch(/stored as "handled" and is read as "implemented"/);
  expect(reqs[0]!.status).toBe("implemented");
});
