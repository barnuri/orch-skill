import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { loadRun } from "../../core/state/store.ts";
autoCleanup();

test("node replace copies a stuck node to a new node and marks the old one covered", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "replace run").out.trim();
  o("node", "add", R, "stuck", "Stuck work", "--profile", "opencode-chip-exec", "--model", "m1");
  const r = o("node", "replace", R, "stuck");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/covered: .*\/stuck by .*\/stuck-r2/);
  const run = (await loadRun(home, R))!;
  const old = run.nodes.find((n: any) => n.id === "stuck") as any;
  const fresh = run.nodes.find((n: any) => n.id === "stuck-r2") as any;
  expect(old.status).toBe("covered");
  expect(old.covered_by).toBe(`${R}/stuck-r2`);
  expect(fresh.status).toBe("waiting");
  expect(fresh.label).toBe("Stuck work");
  expect(fresh.profile).toBe("opencode-chip-exec");
  expect(fresh.model).toBe("m1");
  expect(fresh.replaces).toBe(`${R}/stuck`);
});

test("node replace into another run creates the node there", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const A = o("run", "start", "from").out.trim();
  const B = o("run", "start", "to").out.trim();
  o("node", "add", A, "x", "X work");
  expect(o("node", "replace", A, "x", "--run", B).rc).toBe(0);
  const dst = (await loadRun(home, B))!;
  expect(dst.nodes.some((n: any) => n.id === "x-r2")).toBe(true);
});
