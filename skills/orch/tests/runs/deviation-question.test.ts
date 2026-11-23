import { test, expect } from "bun:test";
import { orch, seedHome, autoCleanup } from "../helpers";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGaps, createGapNodes } from "../../core/commands/gaps.ts";
import { runState } from "../helpers";
autoCleanup();

// A done plan node (T9) whose job changed the given extra files after the start commit.
function deviatingRun(extra: string[], planRows: string) {
  const home = seedHome();
  const o = orch(home, {});
  const repo = mkdtempSync(join(tmpdir(), "deviation-repo-"));
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a]);
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(repo, "base.txt"), "x\n"); git("add", "."); git("commit", "-qm", "base");
  const start = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
  writeFileSync(join(repo, "in-plan.rs"), "a\n");
  for (const f of extra) writeFileSync(join(repo, f), "b\n");
  git("add", "."); git("commit", "-qm", "work");
  const plan = join(home, "plan.md");
  writeFileSync(plan, `| Task | Files |\n|---|---|\n${planRows}`);
  const R = o("run", "start", "deviation run").out.trim();
  o("node", "add", R, "t9", "T9", "--plan", plan, "--task", "T9");
  const job = "job-t9";
  const jd = join(home, "jobs", job); mkdirSync(jd, { recursive: true });
  writeFileSync(join(jd, "repo"), repo + "\n"); writeFileSync(join(jd, "start_commit"), start + "\n");
  o("node", "update", R, "t9", "running", "--job", job, "--owner", "coordinator");
  o("node", "update", R, "t9", "done");
  return { home, o, R };
}

test("a deviation that changes scope is recorded as a question on the node", async () => {
  const { home, o, R } = deviatingRun(["new-feature.rs"], "| T9 | in-plan.rs |\n");
  const gaps = await findGaps(home, R);
  const dev = gaps.find((g) => g.kind === "deviation" && g.id === "t9");
  expect(dev?.scope).toBe(true);
  await createGapNodes(home, R, gaps);
  const node = runState(home, R).nodes.find((n: any) => n.id === "t9");
  expect(String(node.needs_user)).toContain("Node t9 changed a scope outside its plan");
  expect(o("run", "status", R).out).toMatch(/question t9: Node t9 changed a scope/);
});

test("the question is recorded once and clears with the node", async () => {
  const { home, R } = deviatingRun(["new-feature.rs"], "| T9 | in-plan.rs |\n");
  await createGapNodes(home, R, await findGaps(home, R));
  const first = runState(home, R).nodes.find((n: any) => n.id === "t9").needs_user;
  await createGapNodes(home, R, await findGaps(home, R));
  expect(runState(home, R).nodes.find((n: any) => n.id === "t9").needs_user).toBe(first);
});

test("a fix inside another plan task's files is a deviation but not a scope question", async () => {
  const { home, o, R } = deviatingRun(["other.rs"], "| T9 | in-plan.rs |\n| T10 | other.rs |\n");
  const gaps = await findGaps(home, R);
  const dev = gaps.find((g) => g.kind === "deviation" && g.id === "t9");
  expect(dev?.scope).toBe(false);
  await createGapNodes(home, R, gaps);
  const node = runState(home, R).nodes.find((n: any) => n.id === "t9");
  expect(node.needs_user ?? "").toBe("");
  expect(o("run", "status", R).out).not.toMatch(/^question /m);
});
