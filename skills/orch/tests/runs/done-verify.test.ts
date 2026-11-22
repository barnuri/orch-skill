import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { orch, seedHome, nodeOf, autoCleanup } from "../helpers";
autoCleanup();

test("done without handoff is unverified", () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "done check").out.trim();
  for (const n of ["a", "b", "c", "j"]) o("node", "add", R, n, n.toUpperCase());
  const nd = (id: string) => nodeOf(home, R, id);
  o("node", "update", R, "a", "running", "--owner", "coordinator");
  let r = o("node", "update", R, "a", "done");
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/^done without handoff: a /m);
  expect([nd("a").status, nd("a").unverified]).toEqual(["done", true]);
  expect(nd("a").handoff_reason).toBe("handoff.md is missing");
  expect(nd("a").result_reason).toBe("node result was not recorded");
  o("node", "update", R, "b", "running", "--owner", "coordinator");
  writeFileSync(join(o("node", "out", R, "b").out.trim(), "handoff.md"), "");
  expect(o("node", "update", R, "b", "done").all).toMatch(/^done without handoff: b /m);
  expect(nd("b").unverified).toBe(true);
  expect(nd("b").handoff_reason).toBe("handoff.md is empty");
  o("node", "update", R, "c", "running", "--owner", "coordinator");
  writeFileSync(join(o("node", "out", R, "c").out.trim(), "handoff.md"), "did the thing\n");
  o("node", "result", R, "c", "--verdict", "full", "--summary", "finished cleanly");
  expect(o("node", "update", R, "c", "done").all).not.toMatch(/done without handoff/);
  expect(nd("c").unverified ?? null).toBeNull();
  expect(nd("c").handoff_reason ?? null).toBeNull();
  const job = `fakejob-${process.pid}`;
  mkdirSync(join(home, "jobs", job), { recursive: true });
  writeFileSync(join(home, "jobs", job, "exit_code"), "0\n"); writeFileSync(join(home, "jobs", job, "log"), "");
  o("node", "update", R, "j", "running", "--job", job);
  r = o("run", "sync", R, "--no-retry");
  expect(nd("j").status).toBe("error");
  expect(nd("j").error).toBe("ended early without handoff");
  r = o("run", "verify", R);
  expect(r.out).toMatch(/\[a\] node a is unverified: handoff.md is missing; node result was not recorded/);
  o("node", "result", R, "c", "--verdict", "full", "--summary", "finished cleanly");
  expect(o("run", "verify", R).out).not.toMatch(/\[c\] node c is unverified/);
  r = o("run", "status", R, "--fresh");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^fresh [0-9T:-]+Z \[running\] done=a,b,c error=j \(read .*\/state.json\)$/m);
  expect(o("run", "status", R).out).not.toMatch(/^fresh /m);
  expect(JSON.parse(o("run", "status", R, "--fresh", "--json").out).fresh).toMatch(/^fresh /);
});

test("job exit 129 or 1 with a commit becomes done and writes a commit-log handoff", () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0" });
  const R = o("run", "start", "commit handoff").out.trim();
  o("node", "add", R, "committed", "Committed work");
  o("node", "add", R, "no-commit", "No commit work");

  const repo = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "orch-commit-handoff-"));
  for (const [args] of [[["git", "-C", repo, "init", "-q"]], [["git", "-C", repo, "config", "user.email", "orch@example.test"]], [["git", "-C", repo, "config", "user.name", "Orch Test"]]] as any[]) {
    expect(Bun.spawnSync(args as string[], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  }
  writeFileSync(join(repo, "base.txt"), "base\n");
  Bun.spawnSync(["git", "-C", repo, "add", "base.txt"]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "base"]);
  const startCommit = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();

  const committedJob = `commit-job-${process.pid}`;
  mkdirSync(join(home, "jobs", committedJob), { recursive: true });
  writeFileSync(join(home, "jobs", committedJob, "exit_code"), "129\n");
  writeFileSync(join(home, "jobs", committedJob, "log"), "");
  writeFileSync(join(home, "jobs", committedJob, "repo"), `${repo}\n`);
  writeFileSync(join(home, "jobs", committedJob, "start_commit"), `${startCommit}\n`);
  writeFileSync(join(repo, "added.txt"), "added\n");
  Bun.spawnSync(["git", "-C", repo, "add", "added.txt"]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "add result"]);
  o("node", "update", R, "committed", "running", "--job", committedJob);

  const noCommitJob = `no-commit-job-${process.pid}`;
  mkdirSync(join(home, "jobs", noCommitJob), { recursive: true });
  writeFileSync(join(home, "jobs", noCommitJob, "exit_code"), "1\n");
  writeFileSync(join(home, "jobs", noCommitJob, "log"), "");
  writeFileSync(join(home, "jobs", noCommitJob, "repo"), `${repo}\n`);
  const noCommitStart = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  writeFileSync(join(home, "jobs", noCommitJob, "start_commit"), `${noCommitStart}\n`);
  o("node", "update", R, "no-commit", "running", "--job", noCommitJob);

  o("run", "sync", R, "--no-retry");
  expect(nodeOf(home, R, "committed").status).toBe("done");
  expect(nodeOf(home, R, "committed").unverified ?? null).toBeNull();
  const handoff = join(o("node", "out", R, "committed").out.trim(), "handoff.md");
  expect(readFileSync(handoff, "utf8")).toContain("add result");
  expect(nodeOf(home, R, "no-commit").status).toBe("error");
  expect(nodeOf(home, R, "no-commit").error).toBe("ended early without handoff");
});
