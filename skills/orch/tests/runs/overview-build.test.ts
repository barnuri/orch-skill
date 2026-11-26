import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { orch, seedHome, autoCleanup, fakeBin } from "../helpers";
import { buildRunOverview, COMMIT_CAP, resetPullMemo } from "../../core/commands/overview.ts";
import { loadRun, saveRun } from "../../core/state/store.ts";
autoCleanup();

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, subject: string): string {
  writeFileSync(join(repo, file), subject);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", subject);
  return git(repo, "rev-parse", "--short", "HEAD");
}

test("buildRunOverview reads repos, commits, PRs, models, skills, nodes and handoffs from a real run", async () => {
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "overview build").out.trim();
  o("node", "add", R, "a", "Node A");
  o("node", "add", R, "b", "Node B");

  // Repo with a GitHub origin: start commit, then two new commits.
  const repo = mkdtempSync(join(tmpdir(), "ov-build-"));
  git(repo, "init", "-q");
  commit(repo, "base.txt", "base");
  const start = git(repo, "rev-parse", "HEAD");
  const c1 = commit(repo, "one.txt", "first change");
  const c2 = commit(repo, "two.txt", "second change");
  git(repo, "remote", "add", "origin", "git@github.com:acme/orch.git");

  // Job files for node a (repo, start commit, model, log with two skill reads) and node b (no repo).
  const jobs = join(home, "jobs");
  mkdirSync(join(jobs, "job-a"), { recursive: true });
  writeFileSync(join(jobs, "job-a", "repo"), repo);
  writeFileSync(join(jobs, "job-a", "start_commit"), start);
  writeFileSync(join(jobs, "job-a", "model_id"), "claude-x");
  writeFileSync(join(jobs, "job-a", "log.plain"), "Read /s/skills/code-gen/SKILL.md\nRead /s/skills/dev-guidelines/SKILL.md\n");
  mkdirSync(join(jobs, "job-b"), { recursive: true });
  writeFileSync(join(jobs, "job-b", "model_id"), "claude-x");

  // Link jobs to nodes through the run state (the store API that dispatch uses).
  const run = await loadRun(home, R);
  if (!run) throw new Error("run missing");
  for (const n of run.nodes as any[]) {
    n.job_id = n.id === "a" ? "job-a" : "job-b";
    n.status = n.id === "a" ? "done" : "running";
  }
  // Handoff for node a only; node b has none.
  mkdirSync(join(home, "runs", R, "out", "a"), { recursive: true });
  writeFileSync(join(home, "runs", R, "out", "a", "handoff.md"), "# done\n");
  await saveRun(home, R, run);

  const fake = fakeBin({ gh: `echo https://github.com/acme/orch/pull/7` });
  const oldPath = process.env.PATH;
  let ov;
  try {
    process.env.PATH = `${fake}:${oldPath}`;
    ov = await buildRunOverview(home, R);
  } finally {
    process.env.PATH = oldPath;
  }
  if (!ov) throw new Error("no overview");

  expect(ov.node_count).toBe(2);
  expect(ov.repos).toEqual([{ repo, nodes: ["a"], commits: 2 }]);
  expect(ov.commits.map((c) => c.sha)).toEqual([c2, c1]);
  expect(ov.commits[0]?.subject).toBe("second change");
  expect(ov.pull_requests).toEqual([{ repo, url: "https://github.com/acme/orch/pull/7" }]);
  expect(ov.pull_requests_unavailable).toEqual([]);
  expect(ov.models).toEqual([{ name: "claude-x", nodes: 2 }]);
  expect(ov.skills).toEqual([
    { name: "code-gen", nodes: 1 },
    { name: "dev-guidelines", nodes: 1 },
  ]);
  const na = ov.nodes.find((n) => n.id === "a");
  expect(na).toMatchObject({ status: "done", model: "claude-x", repo, skills: ["code-gen", "dev-guidelines"] });
  expect(ov.handoffs.find((h) => h.id === "a")).toMatchObject({ state: "yes", bytes: 7 });
  expect(ov.handoffs.find((h) => h.id === "b")).toMatchObject({ state: "missing", bytes: 0 });
}, 60_000);

test("buildRunOverview returns null for an unknown run and caps commits per repo", async () => {
  const home = seedHome();
  expect(await buildRunOverview(home, "20260101-000000-zzzz")).toBeNull();
  expect(COMMIT_CAP).toBe(20);
});

test("buildRunOverview stops waiting for slow gh lookups after pullsWaitMs and the next build reuses them", async () => {
  resetPullMemo();
  const home = seedHome();
  const o = orch(home, {});
  const R = o("run", "start", "overview slow gh").out.trim();
  o("node", "add", R, "a", "Node A");
  const repo = mkdtempSync(join(tmpdir(), "ov-slow-"));
  git(repo, "init", "-q");
  commit(repo, "base.txt", "base");
  const start = git(repo, "rev-parse", "HEAD");
  commit(repo, "one.txt", "first change");
  git(repo, "remote", "add", "origin", "git@github.com:acme/slow.git");
  mkdirSync(join(home, "jobs", "job-a"), { recursive: true });
  writeFileSync(join(home, "jobs", "job-a", "repo"), repo);
  writeFileSync(join(home, "jobs", "job-a", "start_commit"), start);
  const run = await loadRun(home, R);
  if (!run) throw new Error("run missing");
  for (const n of run.nodes as any[]) n.job_id = "job-a";
  await saveRun(home, R, run);

  const fake = fakeBin({ gh: `sleep 1; echo https://github.com/acme/slow/pull/9` });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fake}:${oldPath}`;
    const t0 = performance.now();
    const fast = await buildRunOverview(home, R, { pullsWaitMs: 100 });
    expect(performance.now() - t0).toBeLessThan(900);
    expect(fast?.pull_requests_pending).toBe(true);
    expect(fast?.pull_requests).toEqual([]);
    // The lookup finishes in the background (slow under machine load): poll until it is memoised.
    for (let i = 0; i < 40; i++) {
      const probe = await buildRunOverview(home, R, { pullsWaitMs: 100 });
      if (!probe?.pull_requests_pending) break;
      await Bun.sleep(250);
    }
    const t1 = performance.now();
    const full = await buildRunOverview(home, R, { pullsWaitMs: 100 });
    expect(performance.now() - t1).toBeLessThan(900);
    expect(full?.pull_requests_pending).toBeUndefined();
    expect(full?.pull_requests).toEqual([{ repo, url: "https://github.com/acme/slow/pull/9" }]);
  } finally {
    process.env.PATH = oldPath;
    resetPullMemo();
  }
}, 60_000);
