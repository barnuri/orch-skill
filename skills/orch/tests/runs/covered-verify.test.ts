import { test, expect } from "bun:test";
import { seedHome, autoCleanup } from "../helpers";
import { loadRun, saveRun } from "../../core/state/store.ts";
import { verifyRun } from "../../core/commands/verify.ts";
autoCleanup();

test("a covered run passes verify when the run that carries its work is done", async () => {
  const home = seedHome();
  const base = { nodes: [], edges: [], started: "2026-11-22T00:00:00Z", finished: null, harness_session: "" };
  await saveRun(home, "old", { ...base, run_id: "old", title: "old", status: "covered", covered_by: "new" } as any);
  await saveRun(home, "new", { ...base, run_id: "new", title: "new", status: "done" } as any);
  const old = (await loadRun(home, "old"))!;
  expect(await verifyRun(home, "old", old)).toEqual([]);
});

test("a covered run fails verify while the carrying run is not done", async () => {
  const home = seedHome();
  const base = { nodes: [], edges: [], started: "2026-11-22T00:00:00Z", finished: null, harness_session: "" };
  await saveRun(home, "old", { ...base, run_id: "old", title: "old", status: "covered", covered_by: "new" } as any);
  await saveRun(home, "new", { ...base, run_id: "new", title: "new", status: "running" } as any);
  const old = (await loadRun(home, "old"))!;
  expect((await verifyRun(home, "old", old)).length).toBe(1);
});
