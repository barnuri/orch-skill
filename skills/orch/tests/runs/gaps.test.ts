import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { loadRun, saveRun } from "../../core/state/store.ts";
import { orchHome } from "../../core/state/home.ts";
autoCleanup();

test("an unhandled request is a gap; the gate refuses to close with it", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "gap run").out.trim();
  o("node", "add", R, "a", "A");
  o("node", "update", R, "a", "skipped");
  o("req", "add", R, "ship the thing", "--node", "a", "--id", "R1");
  o("req", "add", R, "ship alone", "--id", "R2");
  const { findGaps } = await import("../../core/commands/gaps.ts");
  const gaps = await findGaps(home, R);
  expect(gaps.some((g) => g.kind === "request" && g.id === "R1")).toBe(true);
  expect(gaps.some((g) => g.kind === "request" && g.id === "R2")).toBe(true);
  void loadRun; void orchHome;
});

test("a request whose linked node is waiting, running or done is not a gap", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "owned requests").out.trim();
  for (const [id, status] of [["w", ""], ["r", "running"], ["d", "done"]] as const) {
    o("node", "add", R, id, id);
    if (status) o("node", "update", R, id, status, "--force");
    o("req", "add", R, `ship ${id}`, "--node", id, "--id", `R-${id}`);
  }
  const { findGaps } = await import("../../core/commands/gaps.ts");
  const gaps = await findGaps(home, R);
  expect(gaps.filter((g) => g.kind === "request")).toEqual([]);
});

test("open requirements create gap nodes while an unrelated node is running", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "parallel gaps").out.trim();
  o("node", "add", R, "unrelated", "Unrelated work");
  o("node", "update", R, "unrelated", "running");
  o("req", "add", R, "ship first", "--id", "R1");
  o("req", "add", R, "ship second", "--id", "R2");
  const { findGaps, createGapNodes } = await import("../../core/commands/gaps.ts");
  const gaps = await findGaps(home, R);
  const created = await createGapNodes(home, R, gaps);
  expect(created).toEqual(["gap-R1", "gap-R2"]);
  const run = (await loadRun(home, R))!;
  expect(run.nodes.some((n: any) => n.id === "gap-R1")).toBe(true);
  expect(run.nodes.some((n: any) => n.id === "gap-R2")).toBe(true);
});

test("a done node whose owner stopped is a gap until a coordinator result is recorded", async () => {
  const { findGaps } = await import("../../core/commands/gaps.ts");
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "owner stopped").out.trim();
  o("node", "add", R, "n1", "n1");
  o("node", "update", R, "n1", "done", "--force");
  const run = (await loadRun(home, R))!;
  const n = run.nodes.find((x: any) => x.id === "n1") as any;
  n.owner_state = "finished";
  n.result = { verdict: "partial", summary: "self report", follow_up: "", at: "x" };
  await saveRun(home, R, run);
  const gaps = await findGaps(home, R);
  expect(gaps.some((g) => g.kind === "no-result" && g.id === "n1" && /owner stopped/.test(g.detail))).toBe(true);
  o("node", "result", R, "n1", "--verdict", "full", "--summary", "reviewed");
  const after = await findGaps(home, R);
  expect(after.some((g) => g.kind === "no-result" && g.id === "n1")).toBe(false);
});

test("orch-written gap prompts start with the shared node rules", async () => {
  const { AGENT_RULES_LINE } = await import("../../core/commands/gaps.ts");
  const file = AGENT_RULES_LINE.match(/Read (\S+agent-rules\.md)/)?.[1] ?? "";
  expect(require("node:fs").existsSync(file)).toBe(true);
  expect(AGENT_RULES_LINE).toContain("merge");
});
