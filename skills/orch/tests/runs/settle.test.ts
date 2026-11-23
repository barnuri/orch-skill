import { test, expect } from "bun:test";
import { join } from "node:path";
import { autoCleanup, orch, seedHome, nodeOf, readJson } from "../helpers";

autoCleanup();

test("run settle skips unfinished nodes and handles open requirements with evidence", () => {
  const home = seedHome();
  const o = orch(home);
  const run = o("run", "start", "Settle", "--id", "settle-run").out.trim();
  o("node", "add", run, "a", "A");
  o("node", "add", run, "b", "B");
  o("req", "add", run, "Needs a", "--node", "a", "--id", "R1");
  expect(o("run", "settle", run).rc).toBe(2);
  const r = o("run", "settle", run, "--reason", "finished in main session", "--commit", "abc123");
  expect(r.rc).toBe(0);
  expect(r.out).toContain("2 nodes skipped");
  expect(nodeOf(home, run, "a")?.status).toBe("skipped");
  const req = readJson(join(home, "runs", run, "requirements.json")).requirements[0];
  expect(req.status).toBe("handled");
  expect(req.evidence[0].note).toContain("abc123");
}, 120000);
