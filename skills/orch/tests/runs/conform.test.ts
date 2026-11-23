import { test, expect } from "bun:test";
import { planTasks } from "../../core/commands/conform.ts";

test("plan table: task id and its files_touched", () => {
  const plan = [
    "| Task | Files |",
    "|---|---|",
    "| T9 | src/services/local_serving/watchdog.rs, src/routes/proxy.rs |",
    "| T10 | tests/local_serving_watchdog.rs |",
    "| note | not a task |",
  ].join("\n");
  const tasks = planTasks(plan);
  expect(tasks.map((t) => t.id)).toEqual(["T9", "T10"]);
  expect(tasks[0]!.files).toEqual(["src/services/local_serving/watchdog.rs", "src/routes/proxy.rs"]);
});

import { orch, seedHome, autoCleanup } from "../helpers";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformance } from "../../core/commands/conform.ts";
autoCleanup();

test("conformance: a node that changed a file outside its plan task is a deviation", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const repo = mkdtempSync(join(tmpdir(), "conform-repo-"));
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a]);
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(repo, "base.txt"), "x\n"); git("add", "."); git("commit", "-qm", "base");
  const start = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
  writeFileSync(join(repo, "in-plan.rs"), "a\n"); writeFileSync(join(repo, "outside.rs"), "b\n");
  git("add", "."); git("commit", "-qm", "work");
  const plan = join(home, "plan.md");
  writeFileSync(plan, "| Task | Files |\n|---|---|\n| T9 | in-plan.rs |\n");
  const R = o("run", "start", "conform run").out.trim();
  o("node", "add", R, "t9", "T9", "--plan", plan, "--task", "T9");
  const job = "job-t9";
  const jd = join(home, "jobs", job); mkdirSync(jd, { recursive: true });
  writeFileSync(join(jd, "repo"), repo + "\n"); writeFileSync(join(jd, "start_commit"), start + "\n");
  o("node", "update", R, "t9", "running", "--job", job, "--owner", "coordinator");
  const c = await conformance(home, R, "t9", plan, "T9");
  expect(c.ok).toBe(false);
  expect(c.outside).toEqual(["outside.rs"]);
});
