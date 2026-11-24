import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { orch, seedHome, runState, nodeOf, editJson, tempDir, pidAlive, waitUntil, autoCleanup } from "../helpers";
import { setSpawnNode } from "../../core/adapters/spawn-node.ts";
import type { SpawnJob } from "../../core/adapters/types.ts";
import { dispatchNodeJob, retryDispatch } from "../../core/commands/dispatch.ts";
import { stopKillJob } from "../../core/commands/pause.ts";
import { findGaps } from "../../core/commands/gaps.ts";
import { tabBusy, ownerFile } from "../../core/adapters/herdr.ts";
import { gitToplevel } from "../../core/runs/repo.ts";
autoCleanup();

const seen: SpawnJob[] = [];
let n = 0;
setSpawnNode(async (job) => {
  seen.push(job);
  const id = `fake-job-${++n}`;
  mkdirSync(join(job.home, "jobs", id), { recursive: true });
  return { jobId: id };
});

// A real git repo in a temp dir, so "repo" is a path that is not the test process cwd.
function gitRepo(): string {
  const d = tempDir("orch-repo-");
  Bun.spawnSync(["git", "init", "-q", d]);
  return gitToplevel(d)!;
}

function fresh(runCwd?: string) {
  const home = seedHome();
  process.env.HARNESS_ORCH_HOME = home;
  const o = orch(home);
  const r = runCwd
    ? Bun.spawnSync([process.execPath, join(import.meta.dir, "../../scripts/dispatch.ts"), "run", "start", "t", "--id", "rr"], { cwd: runCwd, env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_NO_DONE_GATE: "1" } })
    : null;
  if (!r) o("run", "start", "t", "--id", "rr");
  return { home, o };
}

test("run start records the git toplevel of the caller's cwd; none outside a repo", () => {
  const repo = gitRepo();
  expect(runState(fresh(repo).home, "rr").repo).toBe(repo);
  expect(runState(fresh(tempDir("orch-nogit-")).home, "rr").repo ?? null).toBeNull();
});

test("a person's dispatch records the repo on the node and runs the job there; orch's own dispatches never use the caller's cwd", async () => {
  const personRepo = gitRepo(), runRepo = gitRepo(), nodeRepo = gitRepo(), parentRepo = gitRepo(), hintRepo = gitRepo();
  const { home, o } = fresh(runRepo);
  for (const id of ["own", "child", "hinted", "plain", "person"]) o("node", "add", "rr", id, id);
  o("node", "add", "rr", "parent", "p");
  editJson(join(home, "runs/rr/state.json"), (s) => {
    const by = (id: string) => s.nodes.find((x: any) => x.id === id);
    by("own").repo = nodeRepo;
    by("parent").repo = parentRepo;
  });
  o("node", "add", "rr", "hint-src", "h");
  editJson(join(home, "runs/rr/state.json"), (s) => {
    s.nodes.find((x: any) => x.id === "hint-src").repo = hintRepo;
    s.edges = [["parent", "child"]];
  });
  const go = async (id: string, opts: any = {}) => { seen.length = 0; const r = await dispatchNodeJob(home, "rr", id, ["claude-native", "go"], opts); return { r, repo: seen[0]?.repo }; };

  // heal gap node, retry, advance: no caller repo, so the node's own repo wins over the run's
  expect((await go("own")).repo).toBe(nodeRepo);
  // no own repo: its parent's
  expect((await go("child")).repo).toBe(parentRepo);
  // requirement gap: the repo of the nodes the requirement is linked to
  expect((await go("hinted", { repoHint: ["hint-src"] })).repo).toBe(hintRepo);
  // nothing else known: the run's repo, never the cwd of this process
  const plain = await go("plain");
  expect(plain.repo).toBe(runRepo);
  expect(plain.repo).not.toBe(process.cwd());
  // a person dispatching from a repo records it
  expect((await go("person", { repo: personRepo })).repo).toBe(personRepo);
  expect(nodeOf(home, "rr", "person").repo).toBe(personRepo);
  expect(nodeOf(home, "rr", "own").repo).toBe(nodeRepo);
});

test("a dispatch with no known repo is refused as needs-user and starts no job", async () => {
  const { home, o } = fresh(tempDir("orch-nogit-"));
  o("node", "add", "rr", "x", "x");
  seen.length = 0;
  const r = await dispatchNodeJob(home, "rr", "x", ["claude-native", "go"]);
  expect(r.rc).not.toBe(0);
  expect(seen.length).toBe(0);
  const node = nodeOf(home, "rr", "x");
  expect(node.status).toBe("waiting");
  expect(node.needs_user).toMatch(/dispatch refused: no repo is known/);
});

test("a retry runs in the node's last repo", async () => {
  const runRepo = gitRepo(), nodeRepo = gitRepo();
  const { home, o } = fresh(runRepo);
  o("node", "add", "rr", "a", "a");
  editJson(join(home, "runs/rr/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", adapter: "claude-native", prompt: "go", repo: nodeRepo, error: "boom", job_id: "old" }); });
  seen.length = 0;
  const r = await retryDispatch(home, "rr", "a", "", false, "auto retry", "", false);
  expect(r.rc).toBe(0);
  expect(seen[0]?.repo).toBe(nodeRepo);
});

test("stop kills the whole process tree of a job, including a child in its own process group", async () => {
  const { home } = fresh(gitRepo());
  const job = "j-tree";
  const dir = join(home, "jobs", job);
  mkdirSync(dir, { recursive: true });
  const childPidFile = join(dir, "child.pid");
  // wrapper (job pid) -> child in its own process group, like opencode started by the pane shell
  const wrapper = Bun.spawn([process.execPath, "-e", `const c = Bun.spawn(["sleep","300"], { detached: true }); await Bun.write(${JSON.stringify(childPidFile)}, String(c.pid)); await Bun.sleep(300000)`], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(dir, "pid"), `${wrapper.pid}\n`);
  expect(await waitUntil(() => existsSync(childPidFile) && Boolean(Bun.file(childPidFile).size), 20)).toBe(true);
  const child = Number((await Bun.file(childPidFile).text()).trim());
  expect(pidAlive(child)).toBe(true);
  expect(await stopKillJob(home, job)).toBe(true);
  expect(await waitUntil(() => !pidAlive(child) && !pidAlive(wrapper.pid), 10)).toBe(true);
});

test("retry --force stops the old live job first; without --force it refuses", async () => {
  const runRepo = gitRepo();
  const { home, o } = fresh(runRepo);
  o("node", "add", "rr", "a", "a");
  const old = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const dir = join(home, "jobs", "old-live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pid"), `${old.pid}\n`);
  writeFileSync(join(dir, "node"), "rr/a\n");
  editJson(join(home, "runs/rr/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", adapter: "claude-native", prompt: "go", error: "x", job_id: "old-live" }); });
  seen.length = 0;
  const refused = await retryDispatch(home, "rr", "a", "", false, "manual retry", "", false);
  expect(refused.rc).not.toBe(0);
  expect(seen.length).toBe(0);
  expect(pidAlive(old.pid)).toBe(true);
  const forced = await retryDispatch(home, "rr", "a", "", false, "manual retry", "", true);
  expect(forced.rc).toBe(0);
  expect(seen.length).toBe(1);
  expect(await waitUntil(() => !pidAlive(old.pid), 10)).toBe(true);
});

test("a tab whose owner job still runs is busy, so its pane is never reused", () => {
  const home = seedHome();
  const live = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const jobDir = join(home, "jobs", "j-busy");
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "pid"), `${live.pid}\n`);
  mkdirSync(join(home, "herdr", "tabs"), { recursive: true });
  writeFileSync(ownerFile(home, "w1:t2"), `${jobDir}\n`);
  expect(tabBusy(home, "w1:t2")).toBe(true);
  live.kill();
  const dead = join(home, "jobs", "j-dead");
  mkdirSync(dead, { recursive: true });
  writeFileSync(join(dead, "exit_code"), "0\n");
  writeFileSync(ownerFile(home, "w1:t3"), `${dead}\n`);
  expect(tabBusy(home, "w1:t3")).toBe(false);
  expect(tabBusy(home, "w1:t9")).toBe(false);
});

test("an errored node with attempts left owns its request: no gap node before the retry", async () => {
  const { home, o } = fresh(gitRepo());
  o("node", "add", "rr", "impl", "impl");
  o("req", "add", "rr", "build it", "--node", "impl", "--id", "R1");
  editJson(join(home, "runs/rr/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", prompt: "go", error: "x", attempts: [] }); });
  expect((await findGaps(home, "rr")).filter((g) => g.kind === "request")).toEqual([]);
  // out of attempts (default max 5): the request is a gap again
  editJson(join(home, "runs/rr/state.json"), (s) => { s.nodes[0].attempts = [{}, {}, {}, {}, {}]; });
  expect((await findGaps(home, "rr")).filter((g) => g.kind === "request").map((g) => g.id)).toEqual(["R1"]);
  // no prompt means no retry is possible: gap
  editJson(join(home, "runs/rr/state.json"), (s) => { s.nodes[0].attempts = []; s.nodes[0].prompt = ""; });
  expect((await findGaps(home, "rr")).filter((g) => g.kind === "request").map((g) => g.id)).toEqual(["R1"]);
});

test("a session-only orchestrator is registered when a run is used, so watchdog messages have a target", async () => {
  const { home } = fresh(gitRepo());
  const { coordinatorAutoRecord } = await import("../../core/commands/inbox.ts");
  const saved = { ...process.env };
  try {
    delete process.env.HERDR_PANE_ID; delete process.env.HERDR_SOCKET_PATH; delete process.env.HC_TERMINAL_ID;
    process.env.OPENCODE_SESSION_ID = "ses_worker"; process.env.ORCH_NODE_ID = "some-node";
    await coordinatorAutoRecord(home, "rr");
    expect(runState(home, "rr").coordinator ?? null).toBeNull(); // a node's own session is never the orchestrator
    delete process.env.ORCH_NODE_ID;
    process.env.OPENCODE_SESSION_ID = "ses_orch";
    await coordinatorAutoRecord(home, "rr");
    expect(runState(home, "rr").coordinator).toMatchObject({ transport: "session", session_id: "ses_orch" });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("node dispatch CLI: a person's cwd repo wins, ORCH_AUTO_DISPATCH ignores the cwd and uses the hint, then the run repo", async () => {
  const runRepo = gitRepo(), hintRepo = gitRepo();
  const { home, o } = fresh(runRepo);
  for (const id of ["p", "auto", "hinted"]) o("node", "add", "rr", id, id);
  o("node", "add", "rr", "src", "s");
  editJson(join(home, "runs/rr/state.json"), (s) => { s.nodes.find((x: any) => x.id === "src").repo = hintRepo; });
  // A fake `dispatch.ts start` records the cwd the bridge gave the job.
  const fake = join(tempDir("orch-fake-"), "dispatch.ts");
  writeFileSync(fake, 'await Bun.write(process.env.HARNESS_ORCH_HOME + "/cwd-" + process.env.ORCH_NODE_ID, process.cwd()); console.log("fj-" + process.env.ORCH_NODE_ID);\n');
  const cwdOf = async (id: string) => realpathSync((await Bun.file(join(home, `cwd-${id}`)).text()).trim());
  const run = (env: Record<string, string>, id: string, cwd: string) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "../../scripts/dispatch.ts"), "node", "dispatch", "rr", id, "claude-native", "go"], { cwd, env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_DISPATCH: fake, ...env } });
  const caller = gitRepo();
  expect(run({}, "p", caller).exitCode).toBe(0);
  expect(await cwdOf("p")).toBe(realpathSync(caller));
  expect(nodeOf(home, "rr", "p").repo).toBe(caller);
  expect(run({ ORCH_AUTO_DISPATCH: "1" }, "auto", caller).exitCode).toBe(0);
  expect(await cwdOf("auto")).toBe(realpathSync(runRepo));
  expect(run({ ORCH_AUTO_DISPATCH: "1", ORCH_DISPATCH_REPO_HINT: "src" }, "hinted", caller).exitCode).toBe(0);
  expect(await cwdOf("hinted")).toBe(realpathSync(hintRepo));
});
